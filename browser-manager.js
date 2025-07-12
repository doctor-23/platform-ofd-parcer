const puppeteer = require('puppeteer');
const os = require('os');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs-extra');
const { exec } = require('child_process');
const UserAgent = require('user-agents');

class BrowserManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.browser = null;
        this.page = null;
        this.operationCount = 0;
        this.retryCount = 0;
        this.isInitializing = false;
        this.lastRestartTime = 0;

        // Default settings
        this.options = {
            maxOperationsBeforeRestart: 30,
            maxRetries: 3,
            defaultTimeout: 30000,
            headless: true,
            userDataDir: path.join(process.cwd(), 'browser-data'),
            ...options
        };

        // Create browser data directory
        fs.ensureDirSync(this.options.userDataDir);
    }

    async getPage() {
        while (this.isInitializing) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!this.page || this.page.isClosed()) {
            // Проверяем, нужно ли перезапустить браузер
            const needsRestart = await this.shouldRestartBrowser();
            if (needsRestart) {
                try {
                    await this.restartBrowser();
                } catch (error) {
                    console.error('Failed to restart browser:', error);
                    throw error;
                }
            }

            // Создаем новую страницу
            try {
                this.page = await this.browser.newPage();
                await this.page.setViewport({ width: 1920, height: 1080 });
                await this.page.setUserAgent(new UserAgent().toString());
                await this.page.setDefaultNavigationTimeout(this.options.defaultTimeout);
                await this.page.setDefaultTimeout(this.options.defaultTimeout);
            } catch (error) {
                console.error('Failed to create new page:', error);
                throw error;
            }
        }

        // Проверяем стабильность страницы
        if (!await this.isPageStable(this.page)) {
            throw new Error('Page is not stable');
        }

        this.operationCount++;

        return this.page;
    }

    async isMemoryUsageHigh() {
        if (!this.browser) return false;

        try {
            const memoryInfo = await this.browser.memory();
            const heapUsed = memoryInfo.jsHeapUsedSize;
            const heapTotal = memoryInfo.jsHeapTotalSize;
            const heapUsagePercentage = (heapUsed / heapTotal) * 100;

            console.log(`Memory usage: ${heapUsagePercentage.toFixed(1)}% (used: ${heapUsed} / total: ${heapTotal})`);

            return heapUsagePercentage > 80;
        } catch (error) {
            console.error('Error checking memory usage:', error);
            return false;
        }
    }

    async initializeBrowser() {
        if (this.isInitializing) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return this.initializeBrowser();
        }

        this.isInitializing = true;
        try {
            const launchOptions = {
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-web-security',
                    '--disable-features=NetworkServiceInProcess',
                    '--disable-features=TranslateUI',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-site-isolation-trials',
                    '--host-resolver-rules=MAP * 0.0.0.0 , EXCLUDE localhost',
                    '--dns-prefetch-disable'
                ],
                userDataDir: this.options.userDataDir,
                ignoreHTTPSErrors: true,
                timeout: this.options.defaultTimeout
            };

            if (this.options.proxy) {
                const proxy = this.options.proxy;
                const proxyUrl = proxy.username && proxy.password
                    ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
                    : `http://${proxy.host}:${proxy.port}`;
                launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                launchOptions.args.push(`--proxy-bypass-list=localhost;127.0.0.1;::1;<-loopback>`);
            }

            try {
                this.browser = await puppeteer.launch(launchOptions);
            } catch (error) {
                console.error('Browser launch failed:', error);
                await this.cleanupLockFiles();
                throw error;
            }

            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 1920, height: 1080 });
            await this.page.setUserAgent(new UserAgent().toString());

            this.browser.on('disconnected', async () => {
                console.warn('Browser disconnected, attempting to restart...');
                this.browser = null;
                this.page = null;
                try {
                    await this.restartBrowser();
                } catch (e) {
                    console.error('Failed to restart browser after disconnect:', e);
                }
            });

            await this.page.setJavaScriptEnabled(true);
            await this.page.setDefaultNavigationTimeout(this.options.defaultTimeout);
            await this.page.setDefaultTimeout(this.options.defaultTimeout);
            await this.clearBrowserData();

            console.log('Browser initialized successfully');
            return this.page;
        } catch (error) {
            console.error('Browser initialization failed:', error);
            this.emit('error', error);
            throw error;
        } finally {
            this.isInitializing = false;
        }
    }
    }

    async killProcessTree(pid) {
        try {
            // Получаем список всех дочерних процессов
            const childProcesses = await this.getProcessTree(pid);
            
            // Пробуем закрыть через WebSocket
            try {
                if (this.browser && this.browser.wsEndpoint()) {
                    console.log('Attempting to close browser via WebSocket endpoint...');
                    const browser = await puppeteer.connect({ browserWSEndpoint: this.browser.wsEndpoint() });
                    await browser.close();
                }
            } catch (e) {
                console.warn('Could not close browser via WebSocket:', e.message);
            }

            // Очищаем данные браузера
            try {
                await this.page.evaluate(() => {
                    try {
                        localStorage.clear();
                        sessionStorage.clear();
                        if (indexedDB && indexedDB.databases) {
                            indexedDB.databases().then(dbs => {
                                dbs.forEach(db => {
                                    if (db && db.name) {
                                        indexedDB.deleteDatabase(db.name);
                                    }
                                });
                            }).catch(() => {});
                        }
                    } catch (e) {
                        console.warn('Error clearing storage:', e.message);
                    }
                });
                    } else {
                        resolve();
                    }
                });
            });

            // Проверяем состояние процесса
            const isProcessAlive = await this.isProcessAlive(pid);
            if (isProcessAlive) {
                console.warn('Process still alive, using SIGKILL...');
                const killCmd = process.platform === 'win32' 
                    ? `taskkill /F /T /PID ${pid}` 
                    : `kill -9 ${pid}`;
                await exec(killCmd);
            }

        } catch (error) {
            console.error('Error in killProcessTree:', error);
            throw error;
        } finally {
            console.log('Cleaning up browser resources...');
            
            // Очищаем данные браузера
            try {
                await this.clearBrowserData();
            } catch (e) {
                console.warn('Error clearing browser data:', e.message);
            }
            
            // Удаляем lock-файлы
            try {
                await this.cleanupLockFiles();
            } catch (e) {
                console.warn('Error cleaning up lock files:', e.message);
            }
            
            // Очищаем временные директории
            try {
                const tempDirs = [
                    path.join(this.options.userDataDir, 'Crashpad'),
                    path.join(this.options.userDataDir, 'Crash Reports'),
                    path.join(this.options.userDataDir, 'DawnCache'),
                    path.join(this.options.userDataDir, 'GPUCache'),
                    path.join(this.options.userDataDir, 'ShaderCache'),
                    path.join(this.options.userDataDir, 'shared_proto_db')
                ];
                
                for (const dir of tempDirs) {
                    try {
                        if (fs.existsSync(dir)) {
                            await fs.remove(dir);
                            console.log(`Cleaned up directory: ${dir}`);
                        }
                    } catch (e) {
                        console.warn(`Failed to clean up ${dir}:`, e.message);
                    }
                }
            } catch (e) {
                console.warn('Error cleaning up temp files:', e.message);
            }
            
            // Освобождаем ресурсы
            this.browser = null;
            this.page = null;
        }
    }

    async restartBrowser() {
        const maxRetries = 3;
        const baseDelay = 1000;
        const maxDelay = 10000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Закрываем текущий браузер
                if (this.browser) {
                    await this.closeBrowser();
                }

                // Очищаем данные браузера
                await this.clearBrowserData();

                // Инициализируем новый браузер
                const page = await this.initializeBrowser();

                // Проверяем стабильность страницы
                if (!await this.isPageStable(page)) {
                    throw new Error('Page is not stable after restart');
                }

                console.log(`Browser restarted successfully after ${attempt} attempts`);
                return;

            } catch (error) {
                console.error(`Restart attempt ${attempt} failed:`, error);
                console.error(`Browser restart failed (attempt ${attempt}/${maxRetries}):`, errorMessage);
                
                // Логируем стек для неожиданных ошибок
                if (!errorMessage.includes('timeout') && !errorMessage.includes('Timeout')) {
                    console.error('Error details:', error);
                }

                // Если это последняя попытка, логируем дополнительную информацию и пробрасываем ошибку
                if (attempt === maxRetries) {
                    console.error('Failed to restart browser after multiple attempts');
                    console.error('Last error details:', {
                        message: errorMessage,
                        stack: error.stack,
                        code: error.code,
                        name: error.name
                    });
                    
                    // Пробуем хотя бы закрыть браузер, если он есть
                    try {
                        if (this.browser) {
                            await this.browser.close().catch(() => {});
                        }
                    } catch (e) {
                        // Игнорируем ошибки при закрытии
                    }
                    
                    throw new Error(`Failed to restart browser after ${maxRetries} attempts: ${errorMessage}`);
                }
            }
        }
    }

    async safePageOperation(operation) {
        const maxRetries = 3;
        const baseDelay = 1000;
        const maxDelay = 10000;
        let lastPage = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Получаем страницу
                const page = await this.getPage();
                lastPage = page;

                // Проверяем стабильность страницы
                if (!await this.isPageStable(page)) {
                    throw new Error('Page is not stable');
                }

                // Получаем URL страницы
                const url = await page.evaluate(() => window.location.href);
                console.log(`Operation URL: ${url}`);

                // Выполняем операцию
                const result = await operation(page);

                // Проверяем стабильность страницы после операции
                if (!await this.isPageStable(page)) {
                    throw new Error('Page became unstable after operation');
                }

                return result;

            } catch (error) {
                console.warn(`Attempt ${attempt} failed:`, error.message);

                // Делаем скриншот при ошибке
                if (lastPage && !lastPage.isClosed()) {
                    try {
                        const screenshot = await lastPage.screenshot({ encoding: 'base64' });
                        console.log(`data:image/png;base64,${screenshot}`);
                    } catch (e) {
                        console.warn('Error taking screenshot:', e.message);
                    }
                }

                // Проверяем, нужно ли перезапустить браузер
                if (this.shouldRestartBrowser(error)) {
                    try {
                        await this.restartBrowser();
                    } catch (e) {
                        console.error('Failed to restart browser:', e);
                        throw e;
                    const baseDelay = 2000 * Math.pow(2, attempt);
                    const jitter = Math.floor(Math.random() * 2000); // Добавляем случайность
                    const delay = baseDelay + jitter;
                    
                    console.log(`Retrying in ${Math.round(delay/1000)}s... (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));

                    // Перезапускаем браузер при критических ошибках
                    if (this.shouldRestartBrowser(error)) {
                        console.log('Critical error detected, restarting browser...');
                        try {
                            await this.restartBrowser();
                        } catch (restartError) {
                            console.error('Failed to restart browser:', restartError);
                            // Продолжаем попытки, даже если не удалось перезапустить
                        }
                    }
                } else {
                    // Если последняя попытка, логируем дополнительную информацию
                    console.error('Operation failed after all retries');
                    console.error('Error details:', {
                        message: errorMessage,
                        stack: error.stack,
                        code: error.code,
                        name: error.name
                    });
                }
            }
        }

        // Если все попытки исчерпаны
        const error = new Error(
            `Failed to complete operation after ${maxRetries} attempts: ${error?.message || 'Unknown error'}`
        );
        this.emit('operationFailed', error);
        throw error;
    }

    async closeBrowser() {
        try {
            if (!this.browser) {
                console.log('Browser is already closed');
                return;
            }

            // Закрываем все страницы
            const pages = await this.browser.pages();
            for (const page of pages) {
                try {
                    await page.close();
                } catch (e) {
                    console.warn(`Error closing page: ${e.message}`);
                }
            }

            // Закрываем браузер
            try {
                await this.browser.close();
            } catch (e) {
                console.warn('Error closing browser:', e.message);
                // Принудительно убиваем процесс
                await this.killProcessTree(this.browser.process().pid);
            }

            this.browser = null;
            this.page = null;
            console.log('Browser closed successfully');

        } catch (error) {
            console.error('Error in closeBrowser:', error);
            throw error;
        }
    }

    async cleanupLockFiles() {
        try {
            // Получаем путь к профилю Chromium
            const userDataDir = this.options.userDataDir;
            if (!userDataDir) return;

            // Очищаем lock-файлы
            const lockFiles = [
                path.join(userDataDir, 'SingletonLock'),
                path.join(userDataDir, 'SingletonSocket'),
                path.join(userDataDir, 'SingletonCookie'),
                path.join(userDataDir, 'SingletonPipe'),
                path.join(userDataDir, 'SingletonSocketLock')
            ];

            for (const file of lockFiles) {
                try {
                    if (fs.existsSync(file)) {
                        await fs.remove(file);
                        console.log(`Cleaned up lock file: ${file}`);
                    }
                } catch (e) {
                    console.warn(`Failed to clean up ${file}:`, e.message);
                }
            }

            // Очищаем временные директории
            const tempDirs = [
                path.join(userDataDir, 'Crashpad'),
                path.join(userDataDir, 'Crash Reports'),
                path.join(userDataDir, 'DawnCache'),
                path.join(userDataDir, 'GPUCache'),
                path.join(userDataDir, 'ShaderCache'),
                path.join(userDataDir, 'shared_proto_db'),
                path.join(userDataDir, 'Local State'),
                path.join(userDataDir, 'Preferences')
            ];

            for (const dir of tempDirs) {
                try {
                    if (fs.existsSync(dir)) {
                        await fs.remove(dir);
                        console.log(`Cleaned up directory: ${dir}`);
                    }
                } catch (e) {
                    console.warn(`Failed to clean up ${dir}:`, e.message);
                }
            }
        } catch (error) {
            console.error('Error in cleanupLockFiles:', error);
            throw error;
        }
    }

    async clearBrowserData() {
        try {
            if (!this.page) return;

            await this.page.evaluate(() => {
                try {
                    // Очищаем localStorage
                    localStorage.clear();
                    
                    // Очищаем sessionStorage
                    sessionStorage.clear();
                    
                    // Очищаем IndexedDB
                    if (indexedDB && indexedDB.databases) {
                        indexedDB.databases().then(dbs => {
                            dbs.forEach(db => {
                                if (db && db.name) {
                                    indexedDB.deleteDatabase(db.name);
                                }
                            });
                        }).catch(() => {});
                    }
                    
                    // Очищаем куки
                    document.cookie.split(';').forEach(function(c) {
                        document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
                    });
                    
                    // Очищаем кэш
                    if ('caches' in window) {
                        caches.keys().then(names => {
                            names.forEach(name => {
                                caches.delete(name).catch(() => {});
                            });
                        }).catch(() => {});
                    }
                    
                    // Очищаем сервис-воркеры
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.getRegistrations().then(registrations => {
                            registrations.forEach(registration => {
                                registration.unregister().catch(() => {});
                            });
                        }).catch(() => {});
                    }
                    
                } catch (e) {
                    console.warn('Error clearing browser data:', e.message);
                }
            });
        } catch (error) {
            console.error('Error in clearBrowserData:', error);
            throw error;
        }
    }

    async shouldRestartBrowser(error) {
        if (!error) return false;

        const errorMessage = error.message.toLowerCase();
        
        // Проверяем на DBus ошибки (не критичные)
        if (errorMessage.includes('dbus') || errorMessage.includes('upower')) {
            console.log('Non-critical DBus error detected');
            return false;
        }

        // Проверяем на ошибки прокси
        if (this.options.proxy && errorMessage.includes('proxy')) {
            console.log('Proxy error detected');
            return true;
        }

        // Критические сетевые ошибки
        const criticalNetworkErrors = [
            'net::err_connection_reset',
            'net::err_empty_response',
            'net::err_connection_closed',
            'net::err_connection_failed',
            'net::err_connection_timed_out',
            'net::err_dns_resolution_failed',
            'net::err_ssl_protocol_error',
            'net::err_cert_common_name_invalid',
            'net::err_cert_date_invalid',
            'net::err_cert_authority_invalid'
        ];

        if (criticalNetworkErrors.some(e => errorMessage.includes(e))) {
            console.log('Critical network error detected');
            return true;
        }

        // SSL ошибки
        const sslErrors = [
            'ssl',
            'certificate',
            'tls',
            'handshake',
            'expired',
            'invalid'
        ];

        if (sslErrors.some(e => errorMessage.includes(e))) {
            console.log('SSL error detected');
            return true;
        }

        // Ошибки памяти
        if (errorMessage.includes('out of memory') || errorMessage.includes('oom')) {
            console.log('Memory error detected');
            return true;
        }

        // Ошибки процесса
        if (errorMessage.includes('process') || errorMessage.includes('terminated')) {
            console.log('Process error detected');
            return true;
        }

        // Ошибки браузера
        if (errorMessage.includes('browser') || errorMessage.includes('chromium')) {
            console.log('Browser error detected');
            return true;
        }

        return false;
    }

    async isPageStable(page) {
        if (!page || page.isClosed()) return false;

        try {
            // Проверяем, что страница отзывается
            await page.evaluate(() => true);

            // Проверяем состояние документа
            const readyState = await page.evaluate(() => document.readyState);
            if (readyState !== 'complete') return false;

            // Проверяем наличие модальных диалогов
            const hasDialog = await page.evaluate(() => {
                const dialogs = document.getElementsByTagName('dialog');
                return dialogs.length > 0;
            });
            if (hasDialog) return false;

            // Проверяем состояние сети
            const networkIdle = await page.evaluate(() => {
                const requests = performance.getEntriesByType('resource');
                return requests.every(r => r.duration < 5000);
            });
            if (!networkIdle) return false;

            return true;
            return networkIdle;

        } catch (error) {
            console.warn('Error checking page stability:', error);
            return false;
        }
    }

    async shouldRestartBrowser(error) {
        if (!error || !error.message) return false;

        const errorMessage = error.message.toLowerCase();
        
        // Проверяем на наличие DBus ошибок
        if (errorMessage.includes('dbus') || errorMessage.includes('upower') || 
            errorMessage.includes('systemd') || errorMessage.includes('glib') || 
            errorMessage.includes('gobject')) {
            console.warn('Detected DBus-related error:', errorMessage);
            return true;
        }

        // Проверяем на наличие ошибок с прокси
        if (this.options.proxy && errorMessage.includes('proxy')) {
            return true;
        }

        // Проверяем на наличие критических сетевых ошибок
        const criticalNetworkErrors = [
            'net::err_no_supported_proxies',
            'net::err_proxy_connection_failed',
            'net::err_connection_timed_out',
            'net::err_connection_closed',
            'net::err_connection_reset',
            'net::err_connection_aborted',
            'net::err_connection_refused',
            'net::err_tunnel_connection_failed',
            'net::err_ssl_protocol_error',
            'net::err_invalid_response',
            'net::err_empty_response',
            'net::err_connection_failed',
            'net::err_name_not_resolved',
            'net::err_dns_resolution_failed'
        ];

        if (criticalNetworkErrors.some(error => errorMessage.includes(error))) {
            return true;
        }

        // Проверяем на наличие SSL ошибок
        const sslErrors = [
            'net::err_ssl_version_or_cipher_mismatch',
            'net::err_ssl_weak_server_ephemeral_dh_key',
            'net::err_ssl_server_certificate_error',
            'net::err_ssl_certificate_error',
            'net::err_ssl_weak_server_cipher',
            'net::err_ssl_weak_signature_algorithm',
            'net::err_ssl_unsafe_negotiation'
        ];

        if (sslErrors.some(error => errorMessage.includes(error))) {
            return true;
        }

        // Проверяем на наличие ошибок с памятью
        if (errorMessage.includes('out of memory') || errorMessage.includes('oom')) {
            return true;
        }

        // Проверяем на наличие ошибок с процессом
        if (errorMessage.includes('process') || errorMessage.includes('terminated')) {
            return true;
        }

        // Проверяем на наличие ошибок с браузером
        if (errorMessage.includes('browser') || errorMessage.includes('chromium')) {
            return true;
        }

        return false;
    }

    async performOperation(operation) {
        return this.safePageOperation(operation);
    }
}

// Add error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

module.exports = BrowserManager;

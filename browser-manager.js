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

        const needsRestart =
            !this.browser ||
            !this.page ||
            this.page.isClosed() ||
            this.operationCount >= this.options.maxOperationsBeforeRestart ||
            await this.isMemoryUsageHigh() ||
            Date.now() - this.lastRestartTime > 3600000; // Restart every hour

        if (needsRestart) {
            await this.restartBrowser();
        }

        this.operationCount++;
        return this.page;
    }

    async isMemoryUsageHigh() {
        if (process.platform === 'win32') return false; // Skip memory check on Windows

        try {
            const totalMem = os.totalmem() / (1024 * 1024); // in MB
            const freeMem = os.freemem() / (1024 * 1024); // in MB
            const usedMem = totalMem - freeMem;
            const usagePercent = (usedMem / totalMem) * 100;

            if (usagePercent > 80) {
                console.warn(`High memory usage detected: ${usagePercent.toFixed(2)}%`);
                return true;
            }
            return false;
        } catch (error) {
            console.warn('Failed to check memory usage:', error);
            return false;
        }
    }

    async initializeBrowser() {
        if (this.isInitializing) return;
        this.isInitializing = true;

        try {
            await this.closeBrowser();
            console.log('Initializing new browser instance...');

            // Remove old SingletonLock if it exists
            if (process.platform !== 'win32') {
                try {
                    const lockFile = path.join(this.options.userDataDir, 'SingletonLock');
                    if (fs.existsSync(lockFile)) {
                        fs.unlinkSync(lockFile);
                        console.log('Removed old browser lock file');
                    }
                } catch (e) {
                    console.warn('Failed to remove lock file:', e.message);
                }
            }

            const launchOptions = {
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-webgl',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-site-isolation-trials',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-web-security',
                    '--ignore-certificate-errors',
                    '--ignore-https-errors=yes',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--disable-client-side-phishing-detection',
                    '--disable-default-apps',
                    '--disable-hang-monitor',
                    '--disable-prompt-on-repost',
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-ipc-flooding-protection',
                    '--window-size=1920,1080',
                    `--user-data-dir=${this.options.userDataDir}`,
                    '--remote-debugging-port=0' // Random port
                ],
                timeout: 60000,
                defaultViewport: null,
                ignoreHTTPSErrors: true,
                dumpio: true, // Browser logs to console
                ...this.options.launchOptions
            };

            // Add proxy if configured
            if (this.options.proxy) {
                const proxy = this.options.proxy;
                try {
                    // Формируем URL прокси с учетом аутентификации, если есть
                    const proxyUrl = proxy.username && proxy.password
                        ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
                        : `http://${proxy.host}:${proxy.port}`;

                    console.log(`Using proxy: ${proxy.host}:${proxy.port}`);
                    
                    // Добавляем прокси в аргументы запуска
                    launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                    
                    // Настройка обхода прокси для локальных адресов
                    const bypassList = [
                        'localhost',
                        '127.0.0.1',
                        '::1',
                        '<-loopback>',
                        ...(proxy.bypass || [])
                    ];
                    
                    launchOptions.args.push(`--proxy-bypass-list=${bypassList.join(';')}`);
                    
                    // Дополнительные настройки для стабильности прокси
                    launchOptions.args.push('--disable-features=IsolateOrigins,site-per-process');
                    launchOptions.args.push('--disable-site-isolation-trials');
                    
                } catch (e) {
                    console.error('Error configuring proxy:', e);
                    throw new Error(`Invalid proxy configuration: ${e.message}`);
                }
            }

            // Launch the browser
            this.browser = await puppeteer.launch(launchOptions);

            // Create a new page
            const pages = await this.browser.pages();
            this.page = pages[0] || await this.browser.newPage();

            // Set default navigation timeout
            this.page.setDefaultNavigationTimeout(this.options.defaultTimeout);

            // Browser disconnect handler
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

            // Configure page settings
            await this.page.setUserAgent(new UserAgent().toString());
            await this.page.setJavaScriptEnabled(true);
            await this.page.setDefaultNavigationTimeout(this.options.defaultTimeout);
            await this.page.setDefaultTimeout(this.options.defaultTimeout);

            // Clear browser data
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

    async closeBrowser() {
        if (!this.browser) {
            console.log('No browser instance to close');
            return;
        }

        let browserPid = null;
        let browserWSEndpoint = this.browserWSEndpoint;
        
        try {
            // Получаем PID процесса браузера до закрытия
            try {
                const process = this.browser.process();
                browserPid = process ? process.pid : null;
                console.log(`Closing browser process (PID: ${browserPid || 'unknown'})...`);
            } catch (e) {
                console.warn('Could not get browser process ID:', e.message);
            }

            // Закрываем все страницы
            try {
                const pages = await this.browser.pages();
                console.log(`Closing ${pages.length} pages...`);
                
                // Закрываем страницы с таймаутом
                await Promise.race([
                    Promise.all(pages.map(page => 
                        page.close()
                            .catch(e => console.warn('Error closing page:', e.message))
                    )),
                    new Promise(resolve => setTimeout(resolve, 5000)) // Таймаут 5 секунд
                ]);
            } catch (e) {
                console.warn('Error closing pages:', e.message);
            }

            // Закрываем браузер
            try {
                console.log('Closing browser instance...');
                await this.browser.close();
                console.log('Browser closed successfully');
            } catch (e) {
                console.error('Error closing browser gracefully:', e.message);
                throw e; // Пробрасываем ошибку для обработки в блоке catch
            }
            }

            // Additional cleanup for Unix-based systems
            if (process.platform === 'linux' || process.platform === 'darwin') {
                try {
                    // Kill any remaining Chrome/Chromium processes
                    exec('pkill -f chrome || true');
                    exec('pkill -f chromium || true');
                } catch (e) {
                    console.warn('Error cleaning up browser processes:', e.message);
                }
            }

        } catch (error) {
            console.error('Error during browser cleanup:', error);
            this.emit('error', error);
        } finally {
            this.browser = null;
            this.page = null;
            this.isInitializing = false;

            // Small delay before next operation
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async clearBrowserData() {
        if (!this.page) return;

        try {
            // Clear storage
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
                    console.warn('Failed to clear storage:', e);
                }
            });

            // Clear cookies and cache
            try {
                const client = await this.page.target().createCDPSession();
                await client.send('Network.clearBrowserCookies');
                await client.send('Network.clearBrowserCache');
            } catch (e) {
                console.warn('Failed to clear cookies/cache:', e.message);
            }

            // Clear service workers
            try {
                const client = await this.page.target().createCDPSession();
                await client.send('ServiceWorker.enable');
                const {registrations} = await client.send('ServiceWorker.getRegistrations');
                await Promise.all(registrations.map(registration =>
                    client.send('ServiceWorker.unregister', {
                        scopeUrl: registration.scopeURL
                    }).catch(() => {})
                ));
            } catch (e) {
                console.warn('Failed to clear service workers:', e.message);
            }

        } catch (error) {
            console.warn('Failed to clear browser data:', error);
        }
    }

    async restartBrowser() {
        console.log('Initiating browser restart...');
        this.operationCount = 0;
        this.lastRestartTime = Date.now();

        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`Restart attempt ${attempt}/${maxRetries}`);
                
                // Закрываем браузер с принудительной очисткой
                try {
                    await this.closeBrowser();
                } catch (closeError) {
                    console.warn('Error during browser close:', closeError.message);
                    // Продолжаем, даже если не удалось корректно закрыть
                }

                // Добавляем задержку с экспоненциальной отсрочкой
                if (attempt > 1) {
                    const baseDelay = 2000 * Math.pow(2, attempt);
                    const jitter = Math.floor(Math.random() * 2000); // Добавляем случайность
                    const delay = baseDelay + jitter;
                    
                    console.log(`Waiting ${Math.round(delay/1000)}s before next restart attempt...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

                // Очищаем кэш и временные файлы
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
                        } catch (cleanupError) {
                            console.warn(`Failed to clean up ${dir}:`, cleanupError.message);
                        }
                    }
                } catch (cleanupError) {
                    console.warn('Error during cleanup:', cleanupError.message);
                }

                // Инициализируем новый экземпляр браузера
                console.log('Initializing new browser instance...');
                await this.initializeBrowser();
                
                // Проверяем, что браузер работает
                if (!this.browser || !this.page) {
                    throw new Error('Browser initialization completed but browser or page is null');
                }

                // Проверяем, что страница отвечает
                try {
                    await this.page.evaluate(() => true);
                } catch (e) {
                    throw new Error('New browser page is not responsive');
                }

                console.log('Browser restarted successfully');
                return; // Успешный перезапуск

            } catch (error) {
                lastError = error;
                const errorMessage = error.message || 'Unknown error during browser restart';
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
        const maxRetries = this.options.maxRetries;
        let lastError = null;
        let lastPage = null;
        let operationName = operation.name || 'anonymous';
        
        console.log(`Starting operation: ${operationName}`);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let page;
            try {
                // Получаем страницу с проверкой на необходимость перезапуска браузера
                page = await this.getPage();
                lastPage = page;
                
                // Проверяем, что страница живая
                try {
                    await page.evaluate(() => true);
                } catch (e) {
                    console.warn('Page is not responsive, recreating...');
                    await this.restartBrowser();
                    page = await this.getPage();
                    lastPage = page;
                }

                // Проверяем стабильность страницы
                if (!await this.isPageStable(page)) {
                    throw new Error('Page is not stable');
                }

                console.log(`Operation attempt ${attempt}/${maxRetries}`);
                const result = await operation(page);

                // Проверяем стабильность после операции
                if (!await this.isPageStable(page)) {
                    throw new Error('Page became unstable after operation');
                }

                this.retryCount = 0; // Сбрасываем счетчик попыток при успехе
                console.log(`Operation ${operationName} completed successfully`);
                return result;

            } catch (error) {
                lastError = error;
                const errorMessage = error.message || 'Unknown error';
                console.warn(`Attempt ${attempt}/${maxRetries} failed:`, errorMessage);
                
                // Логируем стек вызовов для ошибок, не связанных с таймаутом
                if (!errorMessage.includes('timeout') && !errorMessage.includes('Timeout')) {
                    console.error('Error stack:', error.stack);
                }
                
                // Делаем скриншот при ошибке, если страница доступна
                if (lastPage && !lastPage.isClosed()) {
                    try {
                        const screenshot = await lastPage.screenshot({ encoding: 'base64' });
                        console.log('Screenshot of the page when error occurred:');
                        console.log(`data:image/png;base64,${screenshot}`);
                    } catch (screenshotError) {
                        console.warn('Failed to take screenshot:', screenshotError.message);
                    }
                }

                if (attempt < maxRetries) {
                    // Экспоненциальная задержка с рандомизацией
                    const baseDelay = 1000 * Math.pow(2, attempt);
                    const jitter = Math.floor(Math.random() * 1000); // Добавляем случайность
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
                }
            }
        }

        // All attempts exhausted
        const error = new Error(
            `Failed to complete operation after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
        );
        this.emit('operationFailed', error);
        throw error;
    }

    shouldRestartBrowser(error) {
        if (!error || !error.message) return false;

        const errorMessage = error.message.toLowerCase();
        const criticalErrors = [
            'navigation', 'timeout', 'detached', 'closed', 'crashed',
            'session', 'target', 'protocol', 'socket', 'connection',
            'no such', 'failed to launch', 'no support', 'proxy',
            'net::', 'ERR_', 'NS_', 'TARGET_', 'ECONNREFUSED', 'ENOTFOUND'
        ];

        return criticalErrors.some(criticalError =>
            errorMessage.includes(criticalError.toLowerCase())
        );
    }

    // Alias for backward compatibility
    async performOperation(operation) {
        return this.safePageOperation(operation);
    }

    async isPageStable(page) {
        if (!page || page.isClosed()) return false;

        try {
            // Check if page is responsive
            await page.evaluate(() => true);

            // Check document ready state
            const isDocumentReady = await page.evaluate(
                () => document.readyState === 'complete' || document.readyState === 'interactive'
            );

            if (!isDocumentReady) return false;

            // Check for modal dialogs
            const hasModal = await page.evaluate(
                () => document.querySelector('dialog[open], .modal[open], .dialog[open]') !== null
            );

            if (hasModal) return false;

            // Check for network idle
            const networkIdle = await page.evaluate(() => {
                try {
                    const resources = window.performance.getEntriesByType('resource') || [];
                    return resources
                        .filter(r => r.initiatorType === 'xmlhttprequest' || r.initiatorType === 'fetch')
                        .every(r => r.duration < 1000); // All requests finished within 1s
                } catch (e) {
                    console.warn('Network idle check failed:', e);
                    return true; // Assume network is idle if check fails
                }
            });

            return networkIdle;

        } catch (error) {
            console.warn('Page stability check failed:', error);
            return false;
        }
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

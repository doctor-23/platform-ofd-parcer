const puppeteer = require('puppeteer');
const os = require('os');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs-extra');

class BrowserManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.browser = null;
        this.page = null;
        this.operationCount = 0;
        this.retryCount = 0;
        this.isInitializing = false;
        this.lastRestartTime = 0;
        
        // Настройки по умолчанию
        this.options = {
            maxOperationsBeforeRestart: 30,
            maxRetries: 3,
            defaultTimeout: 30000,
            headless: true,
            userDataDir: path.join(process.cwd(), 'browser-data'),
            ...options
        };
        
        // Создаем директорию для данных браузера
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
            Date.now() - this.lastRestartTime > 3600000; // Перезапуск каждый час

        if (needsRestart) {
            await this.restartBrowser();
        }

        this.operationCount++;
        return this.page;
    }

    async isMemoryUsageHigh() {
        if (process.platform !== 'win32') return false;
        
        try {
            const totalMem = os.totalmem() / (1024 * 1024); // в МБ
            const freeMem = os.freemem() / (1024 * 1024); // в МБ
            const usedMem = totalMem - freeMem;
            
            return usedMem > (totalMem * 0.8); // 80% использования
        } catch (error) {
            console.warn('Не удалось проверить использование памяти:', error);
            return false;
        }
    }

    async initializeBrowser() {
        if (this.isInitializing) return;
        this.isInitializing = true;

        try {
            await this.closeBrowser();
            console.log('Инициализация нового экземпляра браузера...');
            
            const launchOptions = {
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                    `--user-data-dir=${this.options.userDataDir}`,
                    '--disable-blink-features=AutomationControlled',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-site-isolation-trials'
                ],
                timeout: 60000,
                defaultViewport: null,
                ignoreHTTPSErrors: true,
                ...this.options.launchOptions
            };

            // Добавляем прокси, если указаны
            if (this.options.proxy) {
                const proxy = this.options.proxy;
                const proxyUrl = proxy.username 
                    ? `${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
                    : `${proxy.host}:${proxy.port}`;
                
                launchOptions.args.push(`--proxy-server=${proxyUrl}`);
            }

            this.browser = await puppeteer.launch(launchOptions);

            // Обработчик отключения браузера
            this.browser.on('disconnected', () => {
                console.warn('Браузер отключился, планируем перезапуск...');
                this.restartBrowser().catch(console.error);
            });

            this.page = await this.browser.newPage();
            
            // Установка User-Agent
            if (this.options.userAgent) {
                await this.page.setUserAgent(this.options.userAgent);
            }

            // Настройка таймаутов
            this.page.setDefaultNavigationTimeout(this.options.defaultTimeout);
            this.page.setDefaultTimeout(this.options.defaultTimeout);

            // Эмуляция человека
            await this.page.setExtraHTTPHeaders({
                'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
            });

            await this.page.evaluateOnNewDocument(() => {
                // Удаляем webdriver property
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
                
                // Удаляем свойства, которые могут выдать автоматизацию
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                
                // Эмуляция WebGL
                const getParameter = WebGLRenderingContext.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) {
                        return 'Intel Inc.';
                    }
                    if (parameter === 37446) {
                        return 'Intel Iris OpenGL Engine';
                    }
                    return getParameter(parameter);
                };
            });

            // Очистка данных
            await this.clearBrowserData();

            this.operationCount = 0;
            this.retryCount = 0;
            this.lastRestartTime = Date.now();

            console.log('Браузер успешно инициализирован');
            this.emit('browserRestarted');

        } catch (error) {
            console.error('Ошибка при инициализации браузера:', error);
            this.emit('error', error);
            throw error;
        } finally {
            this.isInitializing = false;
        }
    }

    async clearBrowserData() {
        if (!this.page) return;
        
        try {
            // Очистка кук
            const client = await this.page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.send('Network.clearBrowserCache');
            
            // Очистка хранилищ
            await this.page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
                indexedDB.databases().then(dbs => {
                    dbs.forEach(db => {
                        if (db.name) indexedDB.deleteDatabase(db.name);
                    });
                }).catch(() => {});
            });
            
        } catch (error) {
            console.warn('Не удалось очистить данные браузера:', error);
        }
    }

    async restartBrowser() {
        console.log('Планируется перезапуск браузера...');
        try {
            await this.initializeBrowser();
        } catch (error) {
            console.error('Ошибка при перезапуске браузера:', error);
            // Пробуем снова через 5 секунд
            await new Promise(resolve => setTimeout(resolve, 5000));
            return this.restartBrowser();
        }
    }

    async closeBrowser() {
        try {
            if (this.page && !this.page.isClosed()) {
                await this.page.close().catch(() => {});
            }
            if (this.browser) {
                await this.browser.close().catch(() => {});
            }
        } catch (error) {
            console.error('Ошибка при закрытии браузера:', error);
            this.emit('error', error);
        } finally {
            this.browser = null;
            this.page = null;
        }
    }

    async safePageOperation(operation) {
        const maxRetries = this.options.maxRetries;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const page = await this.getPage();
                
                // Проверяем стабильность страницы перед операцией
                if (!await this.isPageStable(page)) {
                    throw new Error('Page is not stable');
                }

                const result = await operation(page);
                
                // Проверяем стабильность после операции
                if (!await this.isPageStable(page)) {
                    throw new Error('Page became unstable after operation');
                }

                this.retryCount = 0; // Сброс счетчика при успешной операции
                return result;
                
            } catch (error) {
                lastError = error;
                console.warn(`Попытка ${attempt}/${maxRetries} не удалась:`, error.message);
                
                if (attempt < maxRetries) {
                    // Экспоненциальная задержка
                    const delay = 1000 * Math.pow(2, attempt);
                    console.log(`Повтор через ${delay}мс...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    
                    // Принудительный перезапуск браузера при определенных ошибках
                    if (this.shouldRestartBrowser(error)) {
                        console.log('Обнаружена критическая ошибка, перезапускаем браузер...');
                        await this.restartBrowser();
                    }
                }
            }
        }

        // Если все попытки исчерпаны
        const error = new Error(`Не удалось выполнить операцию после ${maxRetries} попыток: ${lastError?.message}`);
        this.emit('operationFailed', error);
        throw error;
    }

    async isPageStable(page) {
        try {
            // Проверяем, что страница жива и отзывчива
            await Promise.race([
                page.evaluate(() => true),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Page not responding')), 5000)
                )
            ]);
            return true;
        } catch (error) {
            console.warn('Проверка стабильности страницы не пройдена:', error);
            return false;
        }
    }

    shouldRestartBrowser(error) {
        if (!error || !error.message) return false;
        
        const errorMessage = error.message.toLowerCase();
        const criticalErrors = [
            'navigating frame was detached',
            'protocol error',
            'target closed',
            'execution context was destroyed',
            'navigation failed',
            'session closed',
            'page crashed',
            'no page',
            'timeout',
            'connection lost'
        ];

        return criticalErrors.some(criticalError => 
            errorMessage.includes(criticalError.toLowerCase())
        );
    }

    async performOperation(operation) {
        return this.safePageOperation(operation);
    }

    getStats() {
        return {
            operationCount: this.operationCount,
            lastRestartTime: new Date(this.lastRestartTime),
            uptime: this.lastRestartTime ? Date.now() - this.lastRestartTime : 0,
            memoryUsage: process.memoryUsage(),
            systemFreeMemory: os.freemem(),
            systemTotalMemory: os.totalmem()
        };
    }
}

module.exports = BrowserManager;

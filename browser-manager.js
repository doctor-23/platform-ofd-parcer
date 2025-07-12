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
                const proxyUrl = proxy.username && proxy.password
                    ? `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
                    : `http://${proxy.host}:${proxy.port}`;

                console.log(`Using proxy: ${proxy.host}:${proxy.port}`);
                launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                launchOptions.args.push('--proxy-bypass-list=<-loopback>');
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
        if (!this.browser) return;

        const browserProcess = this.browser.process();
        const browserPid = browserProcess ? browserProcess.pid : null;

        try {
            // Close all pages
            try {
                const pages = await this.browser.pages();
                await Promise.all(pages.map(page => page.close().catch(e =>
                    console.warn('Error closing page:', e.message)
                )));
            } catch (e) {
                console.warn('Error closing pages:', e.message);
            }

            // Close the browser
            try {
                await this.browser.close();
            } catch (e) {
                console.warn('Error closing browser:', e.message);
                // Force kill the process if it's still alive
                if (browserPid && process.platform !== 'win32') {
                    try {
                        process.kill(browserPid, 'SIGKILL');
                    } catch (killError) {
                        console.warn('Failed to kill browser process:', killError.message);
                    }
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
        console.log('Restarting browser...');
        this.operationCount = 0;
        this.lastRestartTime = Date.now();

        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.closeBrowser();

                // Add delay between retries
                if (attempt > 1) {
                    const delay = 1000 * Math.pow(2, attempt); // Exponential backoff
                    console.log(`Retry ${attempt}/${maxRetries} in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

                await this.initializeBrowser();
                console.log('Browser restarted successfully');
                return; // Success

            } catch (error) {
                lastError = error;
                console.error(`Browser restart failed (attempt ${attempt}/${maxRetries}):`, error.message);

                // If last attempt, rethrow the error
                if (attempt === maxRetries) {
                    console.error('Failed to restart browser after multiple attempts');
                    throw new Error(`Failed to restart browser after ${maxRetries} attempts: ${lastError.message}`);
                }
            }
        }
    }

    async safePageOperation(operation) {
        const maxRetries = this.options.maxRetries;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const page = await this.getPage();

                // Check page stability before operation
                if (!await this.isPageStable(page)) {
                    throw new Error('Page is not stable');
                }

                const result = await operation(page);

                // Check page stability after operation
                if (!await this.isPageStable(page)) {
                    throw new Error('Page became unstable after operation');
                }

                this.retryCount = 0; // Reset retry counter on success
                return result;

            } catch (error) {
                lastError = error;
                console.warn(`Attempt ${attempt}/${maxRetries} failed:`, error.message);

                if (attempt < maxRetries) {
                    // Exponential backoff
                    const delay = 1000 * Math.pow(2, attempt);
                    console.log(`Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));

                    // Force restart on critical errors
                    if (this.shouldRestartBrowser(error)) {
                        console.log('Critical error detected, restarting browser...');
                        await this.restartBrowser();
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

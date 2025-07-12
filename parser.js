const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const UserAgent = require('user-agents');
const { isSuccess, logSuccessId, logFailedId, logErrorId } = require('./utils/storage');
const BrowserManager = require('./browser-manager');
const os = require('os');
// Конфигурация
const CONFIG = {
    threads: 5, // Количество потоков (уменьшено для стабильности)
    maxAttempts: 3, // Попыток на чек
    delayBetweenRequests: 3000, // Задержка между запросами (мс)
    outputDir: 'results',
    captchaDir: 'captcha',
    errorDir: 'errors',
    capmonsterApiKey: 'c0906acd7fe0ee7abf7ae13cd2815be2',
    // Настройки браузера
    browserOptions: {
        headless: true,
        maxOperationsBeforeRestart: 30, // Перезапуск браузера после 30 операций
        defaultTimeout: 60000, // 60 секунд на операцию
        userAgent: new UserAgent().toString(),
    },
    // Список прокси (10 штук)
    proxies: [
        'xUEaT2:yp5SJhxMkS@141.98.134.80:3000',
        'xUEaT2:yp5SJhxMkS@45.88.150.74:3000',
        'xUEaT2:yp5SJhxMkS@45.89.102.188:3000',
        'xUEaT2:yp5SJhxMkS@92.119.41.2:3000',
        'xUEaT2:yp5SJhxMkS@92.119.43.32:3000',
        'xUEaT2:yp5SJhxMkS@46.8.155.59:3000',
        'xUEaT2:yp5SJhxMkS@46.8.222.200:3000',
        'xUEaT2:yp5SJhxMkS@188.130.210.174:3000',
        'xUEaT2:yp5SJhxMkS@45.90.196.78:3000',
        'xUEaT2:yp5SJhxMkS@46.8.222.100:3000',
    ],
    // Файл с чеками (UUID: URL)
    receiptsFile: 'receipts.json',
};

// Вспомогательные функции
function formatDate(date) {
    const d = new Date(date);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function loadReceipts() {
    try {
        if (!fs.existsSync(CONFIG.receiptsFile)) {
            throw new Error('Файл receipts.json не найден');
        }
        return JSON.parse(fs.readFileSync(CONFIG.receiptsFile, 'utf8'));
    } catch (err) {
        console.error('Ошибка загрузки receipts.json:', err.message);
        process.exit(1);
    }
}

// Создаем необходимые директории
[CONFIG.outputDir, CONFIG.captchaDir, CONFIG.errorDir, 'logs'].forEach(dir => {
    fs.ensureDirSync(dir);
});

// Настройка логгера
const logStream = fs.createWriteStream(path.join('logs', `parser_${Date.now()}.log`), { flags: 'a' });

function logToFile(message) {
    const logMessage = `[${formatDate(new Date())}] ${message}\n`;
    logStream.write(logMessage);
    console.log(message);
}

// Обработка ошибок
process.on('uncaughtException', (error) => {
    logToFile(`НЕОБРАБОТАННАЯ ОШИБКА: ${error.message}\n${error.stack}`);
});

process.on('unhandledRejection', (reason) => {
    logToFile(`НЕОБРАБОТАННЫЙ REJECTION: ${reason}`);
});

async function solveCaptcha(imagePath) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const imageBase64 = fs.readFileSync(imagePath, 'base64');
            const { data: taskResp } = await axios({
                method: 'post',
                url: 'https://api.capmonster.cloud/createTask',
                data: {
                    clientKey: CONFIG.capmonsterApiKey,
                    task: { 
                        type: 'ImageToTextTask', 
                        body: imageBase64, 
                        case: true, 
                        numeric: 1,
                        minLength: 4,
                        maxLength: 8
                    }
                },
                timeout: 10000 // 10 секунд таймаут
            });

            const taskId = taskResp.taskId;
            logToFile(`→ Капча отправлена, Task ID: ${taskId}`);

            // Ожидаем решение капчи (макс 2 минуты)
            for (let i = 0; i < 24; i++) {
                await new Promise(r => setTimeout(r, 5000));
                
                const { data: result } = await axios({
                    method: 'post',
                    url: 'https://api.capmonster.cloud/getTaskResult',
                    data: { clientKey: CONFIG.capmonsterApiKey, taskId },
                    timeout: 10000
                });

                if (result.status === 'ready') {
                    logToFile(`✓ Капча решена: ${result.solution.text}`);
                    return result.solution.text;
                }
                
                if (result.errorId !== 0) {
                    throw new Error(result.errorDescription || 'Неизвестная ошибка CapMonster');
                }
            }
            
            throw new Error('Истекло время ожидания капчи');
            
        } catch (error) {
            lastError = error;
            logToFile(`Попытка ${attempt}/${maxRetries} решения капчи не удалась: ${error.message}`);
            
            if (attempt < maxRetries) {
                // Экспоненциальная задержка между попытками
                const delay = Math.min(5000 * Math.pow(2, attempt - 1), 30000);
                logToFile(`Повтор через ${delay/1000} сек...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    
    logToFile(`❌ Не удалось решить капчу: ${lastError?.message}`);
    return null;
}

// Функция для обработки одного чека
async function processReceipt(browserManager, uuid, url, proxy) {
    const startTime = Date.now();
    
    try {
        logToFile(`[${uuid}] Начало обработки`);
        
        // Парсим прокси
        const [auth, hostPort] = proxy.includes('@') 
            ? proxy.split('@') 
            : [null, proxy];
            
        const [host, port] = hostPort.split(':');
        const [username, password] = auth ? auth.split(':') : [null, null];
        
        // Выполняем операцию с автоматическим перехватом ошибок
        await browserManager.performOperation(async (page) => {
            // Настройка прокси аутентификации, если нужно
            if (username && password) {
                await page.authenticate({ username, password });
            }
            
            // Устанавливаем User-Agent
            await page.setUserAgent(CONFIG.browserOptions.userAgent);
            
            // Переходим на страницу
            logToFile(`[${uuid}] Загрузка страницы: ${url}`);
            await page.goto(url, { 
                waitUntil: 'domcontentloaded',
                timeout: 60000,
                referer: 'https://ofd.ru/'
            });
            
            // Проверяем наличие капчи
            logToFile(`[${uuid}] Проверка наличия капчи...`);
            const captchaElement = await page.$('#captchaImg');
            if (!captchaElement) {
                throw new Error('Элемент капчи не найден на странице');
            }
            
            // Делаем скриншот капчи
            const captchaPath = path.join(CONFIG.captchaDir, `captcha_${uuid}.png`);
            await captchaElement.screenshot({ path: captchaPath });
            logToFile(`[${uuid}] Капча сохранена: ${captchaPath}`);
            
            // Решаем капчу
            const captchaText = await solveCaptcha(captchaPath);
            if (!captchaText) {
                throw new Error('Не удалось решить капчу');
            }
            
            // Вводим капчу и отправляем форму
            logToFile(`[${uuid}] Ввод капчи...`);
            await page.type('#captcha', captchaText);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }),
                page.click('button[type="submit"]')
            ]);
            
            // Ждем загрузки результата
            logToFile(`[${uuid}] Ожидание загрузки данных чека...`);
            await page.waitForSelector('.cheque.check.wave-top.wave-white', { 
                timeout: 60000,
                visible: true
            });
            
            // Сохраняем результат
            const html = await page.content();
            const outputPath = path.join(CONFIG.outputDir, `result_${uuid}.html`);
            await fs.writeFile(outputPath, html);
            
            // Логируем успех
            const processingTime = (Date.now() - startTime) / 1000;
            logToFile(`[${uuid}] ✅ Успешно обработан за ${processingTime.toFixed(2)} сек`);
            logSuccessId(uuid);
            
            return true;
        });
        
    } catch (error) {
        const errorMessage = `[${uuid}] ❌ Ошибка: ${error.message}`;
        logToFile(errorMessage);
        logFailedId(uuid, error.message);
        logErrorId(uuid);

        // Сохраняем скриншот при ошибке
        try {
            const screenshotPath = path.join(CONFIG.errorDir, `error_${uuid}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            logToFile(`[${uuid}] Скриншот ошибки сохранен: ${screenshotPath}`);
        } catch (screenshotError) {
            logToFile(`[${uuid}] Не удалось сохранить скриншот: ${screenshotError.message}`);
        }
        
        throw error;
    }
}

// Основная функция
async function main() {
    try {
        // Загружаем чеки
        const receipts = loadReceipts();
        const entries = Object.entries(receipts).filter(([uuid]) => !isSuccess(uuid));

        if (entries.length === 0) {
            logToFile('Нет новых чеков для обработки!');
            return;
        }

        logToFile(`==> Начало обработки (${entries.length} чеков)`);
        
        // Создаем пул браузеров
        const browserPools = [];
        const activeTasks = [];
        
        // Функция для создания нового экземпляра браузера
        const createBrowserInstance = (proxy) => {
            const [auth, hostPort] = proxy.includes('@') 
                ? proxy.split('@') 
                : [null, proxy];
                
            const [host, port] = hostPort.split(':');
            const [username, password] = auth ? auth.split(':') : [null, null];
            
            const browserManager = new BrowserManager({
                ...CONFIG.browserOptions,
                proxy: { host, port, username, password }
            });
            
            // Подписываемся на события браузера
            browserManager
                .on('browserRestarted', () => logToFile('Браузер был перезапущен'))
                .on('error', (error) => logToFile(`Ошибка браузера: ${error.message}`))
                .on('operationFailed', (error) => logToFile(`Ошибка операции: ${error.message}`));
                
            return browserManager;
        };
        
        // Инициализируем пул браузеров
        for (let i = 0; i < Math.min(CONFIG.threads, CONFIG.proxies.length); i++) {
            const proxy = CONFIG.proxies[i % CONFIG.proxies.length];
            browserPools.push({
                manager: createBrowserInstance(proxy),
                isBusy: false,
                proxy
            });
        }
        
        logToFile(`Инициализировано ${browserPools.length} экземпляров браузера`);
        
        // Функция для получения свободного браузера
        const getAvailableBrowser = async () => {
            while (true) {
                const available = browserPools.find(b => !b.isBusy);
                if (available) {
                    available.isBusy = true;
                    return available;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        };
        
        // Обрабатываем чеки
        for (let i = 0; i < entries.length; i++) {
            const [uuid, url] = entries[i];
            
            // Получаем свободный браузер
            const { manager, proxy } = await getAvailableBrowser();
            
            // Запускаем задачу
            const task = (async () => {
                try {
                    await processReceipt(manager, uuid, url, proxy);
                } catch (error) {
                    // Ошибки уже залогированы в processReceipt
                } finally {
                    // Помечаем браузер как свободный
                    const browser = browserPools.find(b => b.manager === manager);
                    if (browser) browser.isBusy = false;
                }
            })();
            
            activeTasks.push(task);
            
            // Добавляем задержку между запуском задач
            if (i < entries.length - 1) {
                await new Promise(r => setTimeout(r, CONFIG.delayBetweenRequests));
            }
        }
        
        // Ожидаем завершения всех задач
        await Promise.all(activeTasks);
        
        // Закрываем все браузеры
        await Promise.all(browserPools.map(b => b.manager.closeBrowser()));
        
        logToFile(`==> Обработка завершена. Обработано ${entries.length} чеков`);
        
    } catch (error) {
        logToFile(`КРИТИЧЕСКАЯ ОШИБКА: ${error.message}\n${error.stack}`);
        process.exit(1);
    } finally {
        // Закрываем лог-файл
        logStream.end();
    }
}

// Запускаем приложение
main().catch(error => {
    console.error('Необработанная ошибка в main:', error);
    process.exit(1);
});

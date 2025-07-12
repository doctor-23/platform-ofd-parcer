const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {Cluster} = require('puppeteer-cluster');

// Конфигурация
const CONFIG = {
    threads: 25, // Количество потоков
    maxAttempts: 3, // Попыток на чек
    delayBetweenRequests: 2000, // Задержка между запросами (мс)
    outputDir: 'results', // Папка для результатов
    capmonsterApiKey: 'c0906acd7fe0ee7abf7ae13cd2815be2', // Получить на https://capmonster.cloud/
    // Список прокси (10 штук)
    proxies: [
        '141.98.134.80:3000',
        '45.88.150.74:3000',
        '45.89.102.188:3000',
        '92.119.41.2:3000',
        '92.119.43.32:3000',
        '46.8.155.59:3000',
        '46.8.222.200:3000',
        '188.130.210.174:3000',
        '45.90.196.78:3000',
        '46.8.222.100:3000',
    ],
    // Чеки (UUID: URL)
    receiptsFile: 'corrections-links.json',
};

function formatDate(date) {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

// Загрузка чеков из JSON
function loadReceipts() {
    try {
        const data = fs.readFileSync(CONFIG.receiptsFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Ошибка загрузки receipts.json:', error.message);
        process.exit(1);
    }
}

// Создаем папку для результатов
if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir);
}

// Решение капчи через CapMonster Cloud
async function solveCaptcha(imagePath) {
    try {
        const imageBase64 = fs.readFileSync(imagePath, {encoding: 'base64'});
        const response = await axios.post('https://api.capmonster.cloud/createTask', {
            clientKey: CONFIG.capmonsterApiKey,
            task: {
                type: 'ImageToTextTask',
                body: imageBase64,
                case: true,
                numeric: 1, // Только цифры
            },
        });

        const taskId = response.data.taskId;
        console.log(`Капча отправлена, Task ID: ${taskId}`);

        // Ожидаем решения (проверяем каждые 2 секунды)
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const result = await axios.post('https://api.capmonster.cloud/getTaskResult', {
                clientKey: CONFIG.capmonsterApiKey,
                taskId: taskId,
            });

            if (result.data.status === 'ready') {
                return result.data.solution.text;
            } else if (result.data.errorId !== 0) {
                throw new Error(result.data.errorDescription);
            }
        }
        throw new Error('Не удалось получить решение капчи');
    } catch (error) {
        console.error('Ошибка CapMonster:', error.message);
        return null;
    }
}

// Главная функция
(async () => {
    const receipts = loadReceipts(); // Загружаем чеки из JSON
    if (Object.keys(receipts).length === 0) {
        console.error('Нет чеков для обработки!');
        process.exit(1);
    }

    // Создаем кластер с 25 потоками
    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_BROWSER,
        maxConcurrency: CONFIG.threads, // 25 параллельных потоков
        puppeteerOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-images'
            ],
        },
        retryLimit: CONFIG.maxAttempts,
        retryDelay: 5000,
    });

    // Обработка одного чека
    await cluster.task(async ({page, data: {uuid, url, proxy}}) => {
        try {
            console.log(`[${uuid}] Обработка через прокси: ${proxy}`);

            // Настраиваем прокси для этого потока
            await page.authenticate({
                username: proxy.split('://')[1].split('@')[0].split(':')[0],
                password: proxy.split('://')[1].split('@')[0].split(':')[1],
            });

            // Переход на страницу
            await page.goto(url, {waitUntil: 'networkidle2', timeout: 30000});

            // Получаем капчу
            const captchaElement = await page.$('#captchaImg');
            const captchaPath = path.join(__dirname, CONFIG.outputDir, `captcha_${uuid}.png`);
            await captchaElement.screenshot({path: captchaPath});

            // Решаем капчу
            const captchaText = await solveCaptcha(captchaPath);
            if (!captchaText) throw new Error('Не удалось решить капчу');

            // Ввод данных
            await page.type('#captcha', captchaText);
            await page.click('button[type="submit"]');

            // Ожидание результата
            await page.waitForSelector('.cheque.check.wave-top.wave-white', {timeout: 15000});

            // Сохранение HTML
            const content = await page.content();
            fs.writeFileSync(path.join(__dirname, CONFIG.outputDir, `result_${uuid}.html`), content);

            console.log(`[${uuid}] Успешно обработан`);
        } catch (error) {
            console.error(`[${uuid}] Ошибка: ${error.message}`);
            throw error; // Для ретраев через cluster
        }
    });

    // Добавляем задачи в кластер с ротацией прокси
    const entries = Object.entries(CONFIG.receipts);
    console.log(`<<<<<<<<<< [${formatDate(new Date())}] Начало обработки`);
    for (let i = 0; i < entries.length; i++) {
        const [uuid, url] = entries[i];
        const proxy = CONFIG.proxies[i % CONFIG.proxies.length]; // Ротация прокси

        cluster.queue({
            uuid,
            url,
            proxy
        });

        // Задержка между добавлением задач
        if (i < entries.length - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));
        }
    }

    // Завершение работы
    await cluster.idle();
    await cluster.close();
    console.log(`<<<<<<<<<< [${formatDate(new Date())}] Обработка завершена`);
    console.log('Все чеки обработаны!');
})();
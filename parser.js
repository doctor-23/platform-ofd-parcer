const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {Cluster} = require('puppeteer-cluster');
const UserAgent = require('user-agents');
const { isSuccess, logSuccessId, logFailedId, logErrorId,  } = require('./utils/storage');
// Конфигурация
const CONFIG = {
    threads: 10, // Количество потоков
    maxAttempts: 3, // Попыток на чек
    delayBetweenRequests: 5000, // Задержка между запросами (мс)
    outputDir: 'results',
    captchaDir: 'captcha',
    errorDir: 'errors',
    capmonsterApiKey: 'c0906acd7fe0ee7abf7ae13cd2815be2', // Получить на https://capmonster.cloud/
    // capmonsterApiKey: 'c0906acd7fe0ee7abf7ae13cd2815be2', // Получить на https://capmonster.cloud/
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
    // Список прокси (10 штук)
    // proxies: [
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    //     'user:pass@ip:port',
    // ],

    // Чеки (UUID: URL)
    receiptsFile: 'receipts.json',
};

// Вспомогательные функции
function formatDate(date) {
    const d = new Date(date);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function loadReceipts() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG.receiptsFile, 'utf8'));
    } catch (err) {
        console.error('Ошибка загрузки receipts.json:', err.message);
        process.exit(1);
    }
}

[CONFIG.outputDir, CONFIG.captchaDir, CONFIG.errorDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

async function solveCaptcha(imagePath) {
    try {
        const imageBase64 = fs.readFileSync(imagePath, 'base64');
        const { data: taskResp } = await axios.post('https://api.capmonster.cloud/createTask', {
            clientKey: CONFIG.capmonsterApiKey,
            task: { type: 'ImageToTextTask', body: imageBase64, case: true, numeric: 1 }
        });

        const taskId = taskResp.taskId;
        console.log(`→ Капча отправлена, Task ID: ${taskId}`);

        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const { data: result } = await axios.post('https://api.capmonster.cloud/getTaskResult', {
                clientKey: CONFIG.capmonsterApiKey,
                taskId
            });

            if (result.status === 'ready') return result.solution.text;
            if (result.errorId !== 0) throw new Error(result.errorDescription);
        }
        throw new Error('Истекло время ожидания капчи');
    } catch (err) {
        console.error('Ошибка CapMonster:', err.message);
        return null;
    }
}

(async () => {
    const receipts = loadReceipts();
    const entries = Object.entries(receipts).filter(([uuid]) => !isSuccess(uuid));

    if (entries.length === 0) {
        console.error('Нет новых чеков для обработки!');
        return;
    }

    console.log(`==> Начало обработки (${entries.length} чеков): ${formatDate(new Date())}`);

    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_PAGE,
        maxConcurrency: CONFIG.threads,
        puppeteerOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-images'
            ]
        },
        retryLimit: CONFIG.maxAttempts,
        retryDelay: 5000
    });

    await cluster.task(async ({ page, data: { uuid, url, proxy } }) => {
        try {
            const randomUA = new UserAgent();
            await page.setUserAgent(randomUA.toString());
            const [auth, host] = proxy.split('@');
            const [username, password] = auth.split(':');
            await page.authenticate({ username, password });

            page.on('close', () => console.warn(`[${uuid}] Page was closed unexpectedly`));

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

            const captchaElement = await page.$('#captchaImg');
            if (!captchaElement) throw new Error('Captcha not found');

            const captchaPath = path.join(CONFIG.captchaDir, `captcha_${uuid}.png`);
            await captchaElement.screenshot({ path: captchaPath });

            const captchaText = await solveCaptcha(captchaPath);
            if (!captchaText) throw new Error('Failed to solve captcha');

            await page.type('#captcha', captchaText);
            await page.click('button[type="submit"]');

            await page.waitForSelector('.cheque.check.wave-top.wave-white', { timeout: 60000 });

            const html = await page.content();
            fs.writeFileSync(path.join(CONFIG.outputDir, `result_${uuid}.html`), html);

            logSuccessId(uuid);
            console.log(`[${uuid}] ✅ Success`);

        } catch (error) {
            logFailedId(uuid, error.message);
            logErrorId(uuid);
            console.error(`[${uuid}] ❌ ${error.message}`);
            throw error;
        }
    });

    for (let i = 0; i < entries.length; i++) {
        const [uuid, url] = entries[i];
        const proxy = CONFIG.proxies[i % CONFIG.proxies.length];
        cluster.queue({ uuid, url, proxy });
        if (i < entries.length - 1) await new Promise(r => setTimeout(r, CONFIG.delayBetweenRequests));
    }

    await cluster.idle();
    await cluster.close();

    console.log(`==> Обработка завершена: ${formatDate(new Date())}`);
})();

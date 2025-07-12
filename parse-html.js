const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Функция для парсинга одного чека
function parseCheck($) {
    const result = {};
    // Заголовки
    result.company = $('.cheque-company__title').text().trim();
    result.address = $('.cheque-company__address').text().trim();
    result.inn = $('.cheque-company__tax-id-number').text().trim().replace(/^ИНН /, '');
    result.place = $('.cheque-company__legal-address').text().replace(/Место расчётов:\s*/, '').trim();

    // Извлекаем URL чека из кнопки скачивания
    const downloadLink = $('.btn.btn-primary.btn-block[href^="/web/noauth/cheque/pdf-"]').attr('href');
    if (downloadLink) {
        const match = downloadLink.match(/pdf-(\d+)-(\d+)-(\d+)/);
        if (match) {
            const [_, id, date, fp] = match;
            result.receipt_url = `https://lk.platformaofd.ru/web/noauth/cheque/id?id=${id}&date=${date}&fp=${fp}`;
        }
    }

    // Основная информация
    const fields = {};
    $('.cheque-text__container').each((_, el) => {
        const key = $(el).find('p').first().text().trim().toLowerCase();
        const value = $(el).find('p').last().text().trim();
        if (key && value) {
            fields[key] = value;
        }
    });

    // Основные поля
    result.check_number = $('.cheque__title').text().match(/№\s*(\d+)/)?.[1] || null;
    result.operation_type = $('.cheque-text__container').first().find('p').first().text().trim();
    result.operation_time = $('.cheque-text__container').first().find('p').last().text().trim();
    result.shift = fields['смена'] || null;
    result.buyer_email = fields['телефон или электронный адрес покупателя'] || null;
    result.tax_system = fields['применяемая система налогообложения'] || null;
    result.cashier = fields['кассир'] || null;
    result.original_fpd = fields['дополнительные данные'] || null;
    result.sender_email = fields['адрес электронной почты отправителя чека'] || null;
    result.kkt_number = fields['номер автомата'] || null;
    result.correction_type = fields['тип коррекции'] || null;
    result.correction_date = fields['дата документа коррекции'] || null;

    // Товары
    result.items = [];
    $('.cheque__products-item').each((_, el) => {
        const name = $(el).find('.cheque__product-title').text().trim();
        const quantityPrice = $(el).find('.text-bold').text().trim();
        const method = $(el).find('.cheque-text__container_dotted').eq(0).find('p').last().text().trim();
        const type = $(el).find('.cheque-text__container_dotted').eq(1).find('p').last().text().trim();
        const vat = $(el).find('.cheque-text__container_dotted').eq(2).find('p').last().text().trim();
        const vatAmount = $(el).find('.cheque-text__container_dotted').eq(3).find('p').last().text().trim();

        result.items.push({
            name,
            quantityPrice,
            method,
            type,
            vat,
            vatAmount
        });
    });

    return result;
}

// Функция для обработки всех файлов в директории results
async function processResultsDirectory() {
    const resultsDir = path.join(__dirname, 'results');
    const resultJsonPath = path.join(__dirname, 'result.json');
    
    // Проверяем и создаем директорию results
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir);
    }

    // Читаем существующий result.json или создаем пустой массив
    let existingResults = [];
    if (fs.existsSync(resultJsonPath)) {
        try {
            existingResults = JSON.parse(fs.readFileSync(resultJsonPath, 'utf-8'));
        } catch (error) {
            console.error('Ошибка при чтении result.json:', error);
            existingResults = [];
        }
    }

    // Получаем список всех HTML файлов в директории results
    const files = fs.readdirSync(resultsDir).filter(file => 
        file.endsWith('.html') && file.startsWith('result_')
    );

    for (const file of files) {
        try {
            const filePath = path.join(resultsDir, file);
            const html = fs.readFileSync(filePath, 'utf-8');
            const $ = cheerio.load(html);

            // Извлекаем id из имени файла
            const match = file.match(/^result_(.+)\.html$/);
            if (!match) {
                console.warn(`Пропускаем файл ${file}: не соответствует паттерну`);
                continue;
            }

            const checkId = match[1];

            // Проверяем, существует ли уже этот id
            const existingCheck = existingResults.find(r => r.id === checkId);
            if (existingCheck) {
                console.log(`Пропускаем файл ${file}: чек с id ${checkId} уже существует`);
                continue;
            }

            // Парсим чек
            const result = parseCheck($);
            result.id = checkId; // Добавляем id после парсинга

            // Добавляем результат
            existingResults.push(result);
            console.log(`Обработан файл ${file}: успешно добавлен чек с id ${checkId}`);

            // Сохраняем результаты после каждого успешного парсинга
            fs.writeFileSync(resultJsonPath, JSON.stringify(existingResults, null, 2));
        } catch (error) {
            console.error(`Ошибка при обработке файла ${file}:`, error);
        }
    }

    console.log(`Обработка завершена. Всего обработано ${existingResults.length} чеков.`);
}

// Запускаем обработку
processResultsDirectory();
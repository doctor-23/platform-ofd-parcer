const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// Загрузим HTML из файла или строки
// Путь к файлу
const filePath = './results/result_49825b98271940518da92d40ae1e38ac.html';

// Чтение HTML
const html = fs.readFileSync(filePath, 'utf-8');

// Извлечение имени файла без пути
const fileName = path.basename(filePath); // 'result_49825b98271940518da92d40ae1e38ac.html'

// Извлечение id из названия файла
const match = fileName.match(/^result_(.+)\.html$/);

if (!match) {
    throw new Error('Не удалось извлечь id из имени файла');
}

const checkId = match[1]; // '49825b98271940518da92d40ae1e38ac' // или html = '<!DOCTYPE html>...'
const $ = cheerio.load(html);

// Функция для парсинга
function parseCheck($) {
    const result = {};

    // Заголовки
    result.company = $('.cheque-company__title').text().trim();
    result.address = $('.cheque-company__address').text().trim();
    result.inn = $('.cheque-company__tax-id-number').text().trim().replace(/^ИНН /, '');
    result.place = $('.cheque-company__legal-address').text().replace(/Место расчётов:\s*/, '').trim();

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
    result.id = checkId;
    result.check_number = $('.cheque__title').text().match(/№\s*(\d+)/)?.[1] || null;
    result.operation_type = $('.cheque-text__container').first().find('p').first().text().trim();
    result.operation_time = $('.cheque-text__container').first().find('p').last().text().trim();
    result.shift = fields['смена'] || null;
    result.buyer_email = fields['телефон или электронный адрес покупателя'] || null;
    result.tax_system = fields['применяемая система налогообложения'] || null;
    result.cashier = fields['кассир'] || null;
    result.fpd = fields['дополнительные данные'] || null;
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

// Используем
const data = parseCheck($);
console.log(JSON.stringify(data, null, 2));

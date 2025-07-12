const fs = require('fs');
const path = require('path');

const resultsFile = path.join(__dirname, 'result.json');
const correctionsReceiptsFile = path.join(__dirname, 'corrections_receipts_data.json');
const newCorrectionsFile = path.join(__dirname, 'corrections.json');

async function loadJsonFile(filePath) {
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Ошибка при загрузке файла ${filePath}:`, error.message);
        process.exit(1);
    }
}

async function processResults() {
    try {
        console.log('Начало обработки данных...');
        const [results, correctionsReceipts] = await Promise.all([
            loadJsonFile(resultsFile),
            loadJsonFile(correctionsReceiptsFile)
        ]);

        console.log(`Загружено ${results.length} результатов и ${correctionsReceipts.length} корректировок`);

        const resultsMap = new Map(results.map(item => [item.id, item]));
        const newCorrections = [];
        const batchSize = 100;
        let processedCount = 0;

        for (let i = 0; i < correctionsReceipts.length; i += batchSize) {
            try {
                const batch = correctionsReceipts.slice(i, i + batchSize);

                await Promise.all(batch.map(async (correction) => {
                    try {
                        const correctionId = correction['Model']?.['Id'];
                        if (!correctionId) return;

                        const matchingResult = resultsMap.get(correctionId);
                        if (matchingResult) {
                            newCorrections.push({
                                ...correction,
                                receipt_data: { ...matchingResult }
                            });
                        }
                    } catch (error) {
                        console.error('Ошибка при обработке коррекции:', error.message);
                        // Продолжаем обработку остальных записей
                    }
                }));

                processedCount = Math.min(i + batchSize, correctionsReceipts.length);
                console.log(`Обработано ${processedCount} из ${correctionsReceipts.length} записей`);

            } catch (batchError) {
                console.error('Ошибка при обработке пакета:', batchError.message);
                // Продолжаем обработку следующих пакетов
            }
        }

        await fs.promises.writeFile(newCorrectionsFile, JSON.stringify(newCorrections, null, 4));
        console.log(`Обработка завершена. Сохранено ${newCorrections.length} записей в ${newCorrectionsFile}`);

    } catch (error) {
        console.error('Критическая ошибка:', error.message);
        process.exit(1);
    }
}

processResults().catch(error => {
    console.error('Необработанная ошибка:', error);
    process.exit(1);
});
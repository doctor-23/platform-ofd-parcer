const { exec } = require('child_process');

const RESTART_INTERVAL_MINUTES = 10;

function restartScript() {
    console.log(`[${new Date().toISOString()}] 🔄 Перезапуск скрипта...`);

    exec('npm run stop && npm run delete && npm run start && npm run log', (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Ошибка при перезапуске: ${error.message}`);
            return;
        }
        if (stderr) console.error(`⚠️ stderr: ${stderr}`);
        console.log(`✅ stdout: ${stdout}`);
    });
}

// Сразу запускаем и затем по интервалу
restartScript();
setInterval(restartScript, RESTART_INTERVAL_MINUTES * 60 * 1000);

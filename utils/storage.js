const fs = require('fs');
const path = require('path');

const successFile = path.join(__dirname, '../results/success.json');
const errorFile = path.join(__dirname, '../errors/failed.json');

function getJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return [];
    }
}

function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function logSuccessId(id) {
    const data = getJSON(successFile);
    if (!data.includes(id)) {
        data.push(id);
        saveJSON(successFile, data);
    }
}

function isSuccess(id) {
    const data = getJSON(successFile);
    return data.includes(id);
}

function logFailedId(id, reason) {
    const errors = getJSON(errorFile);

    const existing = errors.find(e => e.id === id);

    if (existing) {
        existing.attempt += 1;
        existing.reason = reason;
        existing.timestamp = new Date().toISOString();
    } else {
        errors.push({
            id,
            reason,
            attempt: 1,
            timestamp: new Date().toISOString()
        });
    }

    saveJSON(errorFile, errors);
}

function getFailedIds() {
    return getJSON(errorFile);
}

module.exports = {
    logSuccessId,
    isSuccess,
    logFailedId,
    getFailedIds,
};

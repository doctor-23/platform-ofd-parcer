const fs = require('fs');
const path = require('path');

const successFile = path.join(__dirname, '../results/success.json');
const errorFileFull = path.join(__dirname, '../errors/failed.json');
const errorFileIds = path.join(__dirname, '../errors/failed-ids.json');

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

function logErrorId(id) {
    const data = getJSON(errorFileIds);
    if (!data.includes(id)) {
        data.push(id);
        saveJSON(errorFileIds, data);
    }
}

function logFailedId(id, reason) {
    const errors = getJSON(errorFileFull);

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

    saveJSON(errorFileFull, errors);
}

function getFailedIds() {
    return getJSON(errorFile);
}

module.exports = {
    logSuccessId,
    isSuccess,
    logFailedId,
    getFailedIds,
    logErrorId
};

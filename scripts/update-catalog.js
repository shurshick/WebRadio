const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');

const SOURCE = 'https://backups.radio-browser.info/radiobrowser_stations_latest.json.gz';
const TARGET = path.join(__dirname, '..', 'data', 'stations.json');

function download(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 120000 }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Catalog download failed: HTTP ${response.statusCode}`));
                return;
            }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        }).on('error', reject).on('timeout', function () {
            this.destroy(new Error('Catalog download timed out'));
        });
    });
}

function buildCatalog(raw, updatedAt = new Date().toISOString()) {
    const input = Array.isArray(raw) ? raw : raw.stations;
    if (!Array.isArray(input) || input.length < 1000) throw new Error('Catalog is missing or unexpectedly small');
    const seen = new Set();
    const stations = [];
    for (const item of input) {
        const id = String(item.stationuuid || '').trim();
        const name = String(item.name || '').trim();
        const url = String(item.url_resolved || item.url || '').trim();
        if (!id || !name || !/^https?:\/\//i.test(url) || seen.has(id) || item.lastcheckok === false) continue;
        seen.add(id);
        stations.push({
            stationuuid: id,
            name,
            url_resolved: url,
            favicon: String(item.favicon || ''),
            tags: String(item.tags || ''),
            country: String(item.country || ''),
            countrycode: String(item.countrycode || ''),
            codec: String(item.codec || ''),
            bitrate: Number(item.bitrate) || 0,
            votes: Number(item.votes) || 0,
            clickcount: Number(item.clickcount) || 0
        });
    }
    if (stations.length < 1000) throw new Error('Too few valid stations; keeping the previous catalog');
    return { updatedAt, stations };
}

async function main() {
    const compressed = await download(SOURCE);
    const raw = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    const sample = Array.isArray(raw) ? raw[0] : raw.stations?.[0];
    console.log('Export record fields:', Object.keys(sample || {}).join(', '));
    const catalog = buildCatalog(raw);
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    const temp = `${TARGET}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(catalog));
    fs.renameSync(temp, TARGET);
    console.log(`Saved ${catalog.stations.length} stations to ${TARGET}`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildCatalog };

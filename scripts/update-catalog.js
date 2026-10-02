const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');

const SOURCE = 'https://backups.radio-browser.info/radiobrowser_stations_latest.json.gz';
const TARGET = path.join(__dirname, '..', 'data', 'stations.json');
const RANKINGS_TARGET = path.join(__dirname, '..', 'data', 'rankings.json');
const API_MIRRORS = ['de1', 'nl1', 'at1'].map(host => `https://${host}.api.radio-browser.info/json`);

function download(url, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { 'User-Agent': 'SonaraRadio-Catalog/2.4.0' } }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Catalog download failed: HTTP ${response.statusCode}`));
                return;
            }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        }).on('error', reject);
        const timer = setTimeout(() => request.destroy(new Error('Download timed out')), timeout);
        request.on('close', () => clearTimeout(timer));
    });
}

function buildRankings(byClicks, byVotes, updatedAt = new Date().toISOString()) {
    const scores = new Map();
    function collect(list) {
        if (!Array.isArray(list) || list.length === 0) throw new Error('Empty ranking response');
        const ids = [];
        const seen = new Set();
        for (const station of list) {
            const id = station.stationuuid;
            const votes = Number(station.votes);
            const clickcount = Number(station.clickcount);
            if (typeof id !== 'string' || !id || station.votes == null || station.clickcount == null || !Number.isFinite(votes) || !Number.isFinite(clickcount) || votes < 0 || clickcount < 0) {
                throw new Error('Invalid ranking record');
            }
            scores.set(id, { stationuuid: id, votes, clickcount });
            if (!seen.has(id)) ids.push(id);
            seen.add(id);
        }
        return ids;
    }
    const topClicks = collect(byClicks);
    const topVotes = collect(byVotes);
    return { version: 1, updatedAt, topClicks, topVotes, stations: [...scores.values()] };
}

async function fetchRankings(request = download) {
    for (const base of API_MIRRORS) {
        try {
            const responses = await Promise.all([
                request(`${base}/stations/topclick/1000?hidebroken=true`, 15000),
                request(`${base}/stations/topvote/1000?hidebroken=true`, 15000)
            ]);
            return buildRankings(...responses.map(buffer => JSON.parse(buffer.toString('utf8'))));
        } catch (error) { console.warn(`Ranking mirror ${base} failed: ${error.message}`); }
    }
    throw new Error('All ranking mirrors failed; keeping the previous snapshot');
}

function writeJson(target, value) {
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, target);
}

function buildCatalog(raw, updatedAt = new Date().toISOString()) {
    const input = Array.isArray(raw) ? raw : raw.stations;
    if (!Array.isArray(input) || input.length < 1000) throw new Error('Catalog is missing or unexpectedly small');
    const seen = new Set();
    const stations = [];
    const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const item of input) {
        const id = String(item.stationuuid || '').trim();
        const name = String(item.name || '').trim();
        const url = String(item.url_resolved || item.url_stream || item.url || '').trim();
        if (!id || !name || !/^https?:\/\//i.test(url) || seen.has(id) || item.lastcheckok === false) continue;
        seen.add(id);
        const code = String(item.countrycode || item.iso_3166_1 || '').toUpperCase();
        let country = String(item.country || '');
        if (!country && /^[A-Z]{2}$/.test(code)) {
            try { country = countryNames.of(code); } catch { country = code; }
        }
        stations.push({
            stationuuid: id,
            name,
            url_resolved: url,
            favicon: String(item.favicon || item.url_favicon || ''),
            tags: String(item.tags || ''),
            country,
            countrycode: code,
            codec: String(item.codec || ''),
            bitrate: Number(item.bitrate) || 0,
            votes: Number(item.votes) || 0,
            clickcount: Number(item.clickcount) || 0
        });
    }
    if (stations.length < 1000) throw new Error('Too few valid stations; keeping the previous catalog');
    return { updatedAt, stations };
}

async function main(request = download, targets = { catalog: TARGET, rankings: RANKINGS_TARGET }) {
    const compressed = await request(SOURCE);
    const raw = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    const catalog = buildCatalog(raw);
    fs.mkdirSync(path.dirname(targets.catalog), { recursive: true });
    writeJson(targets.catalog, catalog);
    console.log(`Saved ${catalog.stations.length} stations to ${targets.catalog}`);
    try {
        const rankings = await fetchRankings(request);
        writeJson(targets.rankings, rankings);
        console.log(`Saved ${rankings.stations.length} rating records, updated ${rankings.updatedAt}`);
    } catch (error) {
        console.warn(error.message);
        if (fs.existsSync(targets.rankings)) console.log(`Retained ratings dated ${JSON.parse(fs.readFileSync(targets.rankings, 'utf8')).updatedAt}`);
    }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildCatalog, buildRankings, fetchRankings, main };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const Core = require('../js/sonara-core.js');
const buildStandalone = require('../scripts/build-standalone.js');
const { buildCatalog, buildRankings, main: updateCatalog } = require('../scripts/update-catalog.js');
const { gzipSync } = require('node:zlib');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const app = html.match(/<!-- JavaScript Application Logic -->\s*<script src="js\/sonara-core\.js"><\/script>\s*<script>([\s\S]*?)<\/script>/)[1];
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }

function fakeClock() {
    let now = Date.now(), id = 0;
    const jobs = new Map();
    return { get now() { return now; },
        setTimeout(fn, delay) { const key = ++id; jobs.set(key, { fn, at: now + delay }); return key; },
        clearTimeout(key) { jobs.delete(key); },
        advance(duration) {
            const target = now + duration;
            for (;;) {
                const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > target) break;
                now = next[1].at; jobs.delete(next[0]); next[1].fn();
            }
            now = target;
        }, pending: () => jobs.size };
}
function runtime(storageData = {}, fetchImpl = async () => ({ ok: true, json: async () => [] }), indexedDB, fakeGlobalTimers = false) {
    const clock = fakeClock();
    const runtimeCore = { ...Core, createPlaybackController: options => Core.createPlaybackController({ ...options, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }) };
    const nodes = new Map(), listeners = {}, requests = [], store = new Map(Object.entries(storageData));
    function element(id = '') {
        if (nodes.has(id)) return nodes.get(id);
        const classes = new Set();
        const node = { id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', src: '',
            classList: { add: (...x) => x.forEach(v => classes.add(v)), remove: (...x) => x.forEach(v => classes.delete(v)), toggle: x => classes.has(x) ? classes.delete(x) : classes.add(x), contains: x => classes.has(x) },
            addEventListener: (type, fn) => { listeners[id + ':' + type] = fn; },
            appendChild() {}, append() {}, replaceChildren() {}, remove() {}, click() {},
            setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
            getAttribute(key) { return this[key] ?? null; }, play: async () => {}, pause() {}, load() {} };
        nodes.set(id, node); return node;
    }
    const document = { documentElement: { dataset: { theme: 'dark' } }, getElementById: element, createElement: () => element('created' + Math.random()),
        querySelector: () => null, querySelectorAll: () => [], body: element('body'), head: element('head'),
        readyState: 'loading', addEventListener() {} };
    const window = { addEventListener: (type, fn) => { listeners['window:' + type] = fn; } };
    const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
    const context = vm.createContext({ SonaraCore: runtimeCore, document, window, localStorage, navigator: {},
        console: { log() {}, warn() {}, error() {} },
        fetch: (...args) => { requests.push(args[0]); return fetchImpl(...args); },
        AbortSignal, URL, setTimeout: fakeGlobalTimers ? clock.setTimeout : setTimeout, clearTimeout: fakeGlobalTimers ? clock.clearTimeout : clearTimeout, setInterval, clearInterval,
        Date: fakeGlobalTimers ? class extends Date { static now() { return clock.now; } } : Date, Math, indexedDB,
        btoa: str => Buffer.from(str, 'binary').toString('base64'), encodeURIComponent, unescape,
        FileReader: class { readAsText(file) { this.onload({ target: { result: file.text } }); } } });
    vm.runInContext(app, context, { filename: 'index.html' });
    return { context, nodes, listeners, requests, store, clock, boot: () => listeners['window:DOMContentLoaded']() };
}

async function main() {
    await test('station controls wrap the current list and start when the selected station is absent', () => {
        const rt = runtime();
        vm.runInContext("stations = [{stationuuid:'a',name:'A',url_resolved:'https://example.com/a'}, {stationuuid:'b',name:'B',url_resolved:'https://example.com/b'}]", rt.context);
        rt.context.playNextStation(); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'a');
        rt.context.playPrevStation(); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'b');
        rt.context.playNextStation(); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'a');
        vm.runInContext("currentStation = {stationuuid:'outside'}", rt.context);
        rt.context.playPrevStation(); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'b');
        vm.runInContext('stations = []', rt.context);
        rt.context.playNextStation(); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'b');
        rt.context.stopRadio();
    });
    await test('stream backups validate, deduplicate and transfer in backup v3 with v2 import', () => {
        const station = { stationuuid: 'custom_one', name: 'Mine', url_resolved: 'https://example.com/main', alternate_urls: ['https://example.com/main', 'javascript:bad', 'https://example.com/backup'] };
        const payload = Core.createBackup(['custom_one', 'catalog_one'], [station], [{ ...station, stationuuid: 'catalog_one' }], [{ stationuuid: 'catalog_one', urls: ['https://example.com/override', 'https://example.com/backup'] }]);
        const restored = Core.parseBackup(JSON.stringify(payload));
        assert.equal(payload.version, 3);
        assert.deepEqual(restored.customStations[0].alternate_urls, ['https://example.com/backup']);
        assert.deepEqual(restored.streamOverrides[0].urls, ['https://example.com/override', 'https://example.com/backup']);
        assert.deepEqual(Core.parseBackup({ version: 2, favorites: ['old'], customStations: [], savedStations: [] }).streamOverrides, []);
        assert.deepEqual(Core.normalizeStreamUrls(['file:///local', 'https://', null]), []);
    });
    await test('controller retries twice per address, advances backups and stops after exhaustion', () => {
        const clock = fakeClock(), attempts = [], states = [];
        const controller = Core.createPlaybackController({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
            connect: (url, token) => attempts.push({ url, token }), disconnect() {}, onState: state => states.push(state) });
        controller.start(['https://example.com/main', 'https://example.com/backup']);
        for (let address = 0; address < 2; address++) {
            for (let attempt = 0; attempt < 3; attempt++) {
                controller.fail(controller.snapshot().token);
                if (attempt < 2) {
                    const count = attempts.length, delay = attempt === 0 ? 1500 : 3000;
                    clock.advance(delay - 1); assert.equal(attempts.length, count);
                    clock.advance(1); assert.equal(attempts.length, count + 1);
                } else if (address === 0) clock.advance(1500);
            }
        }
        assert.equal(attempts.length, 6);
        assert.equal(controller.snapshot().phase, 'failed');
        clock.advance(100000); assert.equal(attempts.length, 6); assert.equal(clock.pending(), 0);
        assert.deepEqual(attempts.map(a => a.url), Array(3).fill('https://example.com/main').concat(Array(3).fill('https://example.com/backup')));
        assert(states.includes('switching'));
    });
    await test('late promises, duplicate errors and stopped reconnects cannot resume an old attempt', () => {
        const clock = fakeClock(), attempts = [];
        const controller = Core.createPlaybackController({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, connect: (url, token) => attempts.push({ url, token }), disconnect() {}, onState() {} });
        controller.start(['https://example.com/old']); const oldToken = controller.snapshot().token;
        controller.fail(oldToken); controller.fail(oldToken);
        assert.equal(controller.snapshot().retries, 1);
        controller.start(['https://example.com/new']);
        controller.fail(oldToken); controller.playing(oldToken);
        assert.equal(controller.snapshot().phase, 'connecting');
        controller.stop(); clock.advance(100000);
        assert.equal(attempts.length, 2); assert.equal(clock.pending(), 0);
    });
    await test('timeouts recover stalled playback and fleeting playing events do not reset retry budget', () => {
        const clock = fakeClock();
        const controller = Core.createPlaybackController({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, connect() {}, disconnect() {}, onState() {} });
        controller.start(['https://example.com/live']);
        clock.advance(12000); assert.equal(controller.snapshot().phase, 'backoff');
        clock.advance(1500); controller.playing(); controller.waiting();
        clock.advance(15000); assert.equal(controller.snapshot().retries, 2);
        clock.advance(3000); controller.playing(); controller.waiting();
        clock.advance(15000); assert.equal(controller.snapshot().phase, 'failed');
        controller.start(['https://example.com/live']); controller.fail(controller.snapshot().token);
        clock.advance(1500); controller.playing(); clock.advance(30000);
        assert.equal(controller.snapshot().retries, 0); controller.stop();
    });
    function failSelectedStation(rt) {
        for (let attempt = 0; attempt < 3; attempt++) {
            vm.runInContext("playbackController.fail(activeAttemptToken, 'network')", rt.context);
            if (attempt < 2) rt.clock.advance(attempt === 0 ? 1500 : 3000);
        }
    }
    function countdownRuntime() {
        const rt = runtime({}, undefined, undefined, true);
        vm.runInContext("stations = Array.from({length: 6}, (_, i) => ({ stationuuid: 'custom_' + i, name: 'Station ' + i, url_resolved: 'https://example.com/' + i })); allLoadedStations = stations", rt.context);
        rt.context.playStation('custom_0');
        return rt;
    }
    await test('Next countdown advances at ten seconds and never changes station early', () => {
        const rt = countdownRuntime(); failSelectedStation(rt);
        assert.equal(rt.nodes.get('failureNextButton').textContent, 'Следующая (10)');
        rt.clock.advance(9000); assert.equal(rt.nodes.get('failureNextButton').textContent, 'Следующая (1)');
        assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_0');
        rt.clock.advance(1000); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_1');
        rt.context.stopRadio();
    });
    await test('cancel, stop, retry and manual station selection cancel automatic Next', () => {
        for (const action of ['cancelNextStationCountdown', 'stopRadio', 'retryCurrentStation']) {
            const rt = countdownRuntime(); failSelectedStation(rt); rt.context[action](); rt.clock.advance(10000);
            assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_0'); rt.context.stopRadio();
        }
        const rt = countdownRuntime(); failSelectedStation(rt); rt.context.playStation('custom_4'); rt.clock.advance(10000);
        assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_4'); rt.context.stopRadio();
    });
    await test('automatic station chain stops after five failures and blocked playback does not skip', () => {
        const rt = countdownRuntime();
        for (let i = 0; i < 5; i++) { failSelectedStation(rt); if (i < 4) rt.clock.advance(10000); }
        assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_4');
        assert.match(rt.nodes.get('playerStatusText').textContent, /пяти отказов/);
        rt.clock.advance(100000); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_4');
        rt.context.retryCurrentStation(); vm.runInContext("playbackController.fail(activeAttemptToken, 'blocked')", rt.context);
        rt.clock.advance(100000); assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'custom_4');
        assert.match(rt.nodes.get('playerStatusText').textContent, /Браузер запретил/); rt.context.stopRadio();
    });
    await test('custom form and catalog address editor persist backup URLs without replacing station identity', async () => {
        const rt = runtime(); rt.context.openCustomModal();
        rt.nodes.get('customName').value = 'Mine'; rt.nodes.get('customUrl').value = 'https://example.com/main';
        rt.nodes.get('customBackupUrls').value = 'https://example.com/backup\nhttps://example.com/backup';
        rt.context.saveCustomStation(); await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(JSON.parse(rt.store.get('auraradio_custom'))[0].alternate_urls, ['https://example.com/backup']);
        vm.runInContext("stations = [{stationuuid: 'catalog_one', name: 'Catalog', url_resolved: 'https://example.com/original'}]", rt.context);
        rt.context.openStreamUrlsModal('catalog_one');
        rt.nodes.get('streamUrlsInput').value = 'https://example.com/main\nhttps://example.com/backup'; rt.context.saveStreamUrls();
        rt.context.playStation('catalog_one');
        assert.equal(vm.runInContext('currentStation.stationuuid', rt.context), 'catalog_one');
        assert.equal(rt.nodes.get('audioElement').src, 'https://example.com/main');
        assert.equal(JSON.parse(rt.store.get('sonara_stream_urls'))[0].urls.length, 2); rt.context.stopRadio();
    });
    await test('playback indicator follows playing, waiting, pause, ended and emptied', () => {
        const rt = runtime(); rt.boot();
        const eq = rt.nodes.get('equalizer');
        for (const event of ['playing', 'waiting', 'playing', 'pause', 'playing', 'ended']) {
            if (event === 'playing' && !vm.runInContext('isPlaying', rt.context)) rt.context.playStreamUrl('https://example.com/live');
            rt.nodes.get('audioElement').duration = 2;
            rt.listeners['audioElement:' + event]();
            assert.equal(eq.classList.contains('paused-eq'), event !== 'playing');
            assert.equal(vm.runInContext('isPlaying', rt.context), event === 'playing' || event === 'waiting');
        }
    });
    await test('new stream and rejected playback stop decorative animation', async () => {
        const rt = runtime(); rt.boot();
        rt.context.playStreamUrl('https://example.com/previous');
        rt.listeners['audioElement:playing']();
        rt.nodes.get('audioElement').play = () => Promise.reject(new Error('unsupported stream'));
        rt.context.playStreamUrl('https://example.com/bad');
        assert(rt.nodes.get('equalizer').classList.contains('paused-eq'));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(vm.runInContext('playbackController.snapshot().phase', rt.context), 'backoff');
        assert.match(rt.nodes.get('playerStatusText').textContent, /Переподключение/);
        rt.context.stopRadio();
    });
    await test('custom station form saves playable favorite and rejects invalid URL', async () => {
        const rt = runtime();
        rt.context.openCustomModal();
        rt.nodes.get('customName').value = 'My Radio';
        rt.nodes.get('customUrl').value = 'javascript:alert(1)';
        rt.context.saveCustomStation();
        assert(!rt.store.has('auraradio_custom'));
        rt.nodes.get('customUrl').value = 'https://example.com/live';
        rt.context.saveCustomStation();
        await new Promise(resolve => setTimeout(resolve, 0));
        const station = JSON.parse(rt.store.get('auraradio_custom'))[0];
        assert.equal(station.codec, ''); assert.equal(station.bitrate, 0);
        assert.equal(station.votes, null);
        assert(JSON.parse(rt.store.get('auraradio_favorites')).includes(station.stationuuid));
        assert(rt.nodes.get('customModal').classList.contains('hidden'));
        rt.context.playStation(station.stationuuid);
        assert.equal(rt.nodes.get('audioElement').src, station.url_resolved);
        assert.equal(rt.nodes.get('playerCodec').textContent, '—');
        assert(!rt.requests.some(url => url.includes('/url/custom_')));
    });
    await test('UI handlers are defined and Media Session actions do not toggle the opposite state', () => {
        const rt = runtime();
        for (const handler of html.matchAll(/on(?:click|change|input)="(\w+)\(/g)) assert.equal(typeof rt.context[handler[1]], 'function', handler[1]);
        const handlers = {};
        rt.context.navigator.mediaSession = { setActionHandler(action, fn) { handlers[action] = fn; } };
        rt.context.MediaMetadata = class { constructor(data) { Object.assign(this, data); } };
        vm.runInContext("currentStation = { stationuuid: 'test', name: 'Test', url_resolved: 'https://example.com/live' }", rt.context);
        rt.context.updateMediaSession(vm.runInContext('currentStation', rt.context));
        handlers.play(); handlers.play();
        assert.equal(rt.nodes.get('audioElement').src, 'https://example.com/live');
        assert.equal(vm.runInContext('isPlaying', rt.context), true);
        handlers.pause(); handlers.pause();
        assert.equal(vm.runInContext('isPlaying', rt.context), false);
        assert.equal(rt.nodes.get('audioElement').src, undefined);
    });
    const sampleStations = () => Array.from({ length: 1001 }, (_, i) => ({ stationuuid: `saved-${i}`, name: `Saved Radio ${i}`, url_resolved: `https://example.com/${i}`, votes: i, clickcount: i }));
    const snapshot = (savedAt = Date.now()) => ({ version: 1, savedAt, updatedAt: '2026-10-01T00:00:00Z', rankingsUpdatedAt: '2026-10-01T00:00:00Z', stations: sampleStations() });
    await test('favorite backup v3 transfers playable metadata and accepts v1 and legacy', async () => {
        const station = sampleStations()[0];
        const payload = Core.createBackup([station.stationuuid], [], [station, { ...station, stationuuid: 'unrelated' }, { stationuuid: 'bad', name: 'Bad', url_resolved: 'javascript:alert(1)' }]);
        assert.equal(payload.savedStations.length, 1);
        const rt = runtime({}, async () => { throw new Error('offline'); });
        rt.context.importFavorites({ target: { files: [{ text: JSON.stringify(payload) }], value: '' } });
        rt.requests.length = 0;
        rt.context.switchTab('favorites');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(vm.runInContext('stations[0].url_resolved', rt.context), station.url_resolved);
        assert(!rt.requests.some(url => url.includes('/stations/byuuid')));
        rt.context.playStation(station.stationuuid);
        assert.equal(rt.nodes.get('audioElement')?.src || vm.runInContext('audioElement.src', rt.context), station.url_resolved);
        assert.deepEqual(Core.parseBackup({ version: 1, favorites: ['old'], customStations: [] }).savedStations, []);
        assert.deepEqual(Core.parseBackup(['old']).favorites, ['old']);
    });
    await test('migration protects favorites from the bounded recent station cache', () => {
        const favorite = sampleStations()[0];
        const rt = runtime({ auraradio_favorites: JSON.stringify([favorite.stationuuid]), auraradio_station_cache: JSON.stringify({ [favorite.stationuuid]: favorite }) });
        for (let i = 1; i < 250; i++) rt.context.cacheStation({ stationuuid: `other-${i}`, name: 'Other', url_resolved: 'https://example.com/other' });
        assert.equal(JSON.parse(rt.store.get('sonara_favorite_stations'))[0].stationuuid, favorite.stationuuid);
        assert.equal(Object.keys(JSON.parse(rt.store.get('auraradio_station_cache'))).length, 200);
    });
    await test('catalog and ratings survive a new session with all sources unavailable', async () => {
        const db = new IDBFactory();
        assert(await Core.createCatalogStore(db).write(snapshot()));
        const rt = runtime({}, async () => { throw new Error('offline'); }, db);
        const result = await rt.context.fetchApi('/stations/topvote/100');
        assert.equal(result[0].stationuuid, 'saved-1000');
        assert.equal(result[0].votes, 1000);
        assert.match(rt.nodes.get('catalogSourceStatus').textContent, /Сохранённый каталог.*рейтинг на/);
        assert.equal(rt.requests.length, 3);
    });
    await test('saved catalog preview appears before API completion and live result wins', async () => {
        const db = new IDBFactory();
        await Core.createCatalogStore(db).write(snapshot());
        let release;
        const rt = runtime({}, () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => [{ stationuuid: 'live', name: 'Live', url_resolved: 'https://example.com/live' }] }); }), db);
        const pending = rt.context.loadStations('explore');
        await vm.runInContext('catalogReady', rt.context);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(vm.runInContext('stations[0].stationuuid', rt.context), 'saved-1000');
        release(); await pending;
        assert.equal(vm.runInContext('stations[0].stationuuid', rt.context), 'live');
        assert.match(rt.nodes.get('catalogSourceStatus').textContent, /API/);
    });
    await test('stale cache refresh preserves last ratings when ratings request fails', async () => {
        const db = new IDBFactory();
        await Core.createCatalogStore(db).write(snapshot(0));
        const rt = runtime({}, async url => ({ ok: !url.includes('api.radio-browser.info') && !url.endsWith('rankings.json'), status: 503, json: async () => ({ updatedAt: '2026-10-02T00:00:00Z', stations: sampleStations().map(s => ({ ...s, votes: 0, clickcount: 0 })) }) }), db);
        await rt.context.loadStaticCatalog();
        await rt.context.refreshStaticCatalog();
        const stored = await Core.createCatalogStore(db).read();
        assert.equal(stored.updatedAt, '2026-10-02T00:00:00Z');
        assert.equal(stored.rankingsUpdatedAt, '2026-10-01T00:00:00Z');
        assert.equal(stored.stations[10].votes, 10);
        assert(stored.savedAt > 0);
    });
    await test('denied storage, corrupt cache and refresh failures leave fallback usable', async () => {
        assert.equal(await Core.createCatalogStore({ open() { throw new Error('denied'); } }).read(), null);
        const db = new IDBFactory();
        await Core.createCatalogStore(db).write({ version: 1, savedAt: 1, stations: [{ name: 'corrupt' }] });
        const rt = runtime({}, async () => { throw new Error('offline'); }, db);
        const result = await rt.context.fetchApi('/stations/search?name=Relax');
        assert.equal(result[0].name, 'Relax FM');
        assert.equal((await Core.createCatalogStore(db).read()).stations[0].name, 'corrupt');
    });
    await test('an older server catalog cannot replace a newer saved snapshot', async () => {
        const db = new IDBFactory();
        const previous = snapshot(0);
        await Core.createCatalogStore(db).write(previous);
        const rt = runtime({}, async () => ({ ok: true, json: async () => ({ updatedAt: '2026-09-01T00:00:00Z', stations: sampleStations() }) }), db);
        await vm.runInContext('catalogReady', rt.context);
        await assert.rejects(rt.context.refreshStaticCatalog(), /unavailable/);
        assert.deepEqual(await Core.createCatalogStore(db).read(), previous);
    });
    await test('catalog export keeps valid playable stations and rejects incomplete snapshots', () => {
        const input = Array.from({ length: 1001 }, (_, i) => ({ stationuuid: `id-${i}`, name: `Station ${i}`, url_stream: `https://example.com/${i}`, iso_3166_1: 'RU', url_favicon: 'https://example.com/icon.png' }));
        input.push({ ...input[0] }, { stationuuid: 'broken', name: 'Broken', url: 'javascript:alert(1)' });
        const catalog = buildCatalog(input, '2026-10-01T00:00:00Z');
        assert.equal(catalog.stations.length, 1001);
        assert.equal(catalog.stations[0].url_resolved, 'https://example.com/0');
        assert.equal(catalog.stations[0].countrycode, 'RU');
        assert.equal(catalog.stations[0].favicon, 'https://example.com/icon.png');
        assert.throws(() => buildCatalog(input.slice(0, 2)), /small/);
    });
    await test('live API has priority over the GitHub snapshot', async () => {
        const rt = runtime({}, url => {
            assert(url.includes('api.radio-browser.info'));
            return Promise.resolve({ ok: true, json: async () => [{ stationuuid: 'live', name: 'Live', url_resolved: 'https://example.com/live' }] });
        });
        const result = await rt.context.fetchApi('/stations/search?name=Live&limit=10');
        assert.equal(result[0].stationuuid, 'live');
        assert.equal(rt.requests.length, 1);
    });
    await test('ranking export merges UUIDs, preserves real zero and rejects missing scores', () => {
        const a = { stationuuid: 'a', votes: 0, clickcount: 12 };
        const b = { stationuuid: 'b', votes: 50, clickcount: 0 };
        const result = buildRankings([a, b], [b, a], '2026-10-01T00:00:00Z');
        assert.equal(result.stations.length, 2);
        assert.deepEqual(result.topVotes, ['b', 'a']);
        assert.equal(result.stations[0].votes, 0);
        assert.throws(() => buildRankings([], [b]), /Empty/);
        assert.throws(() => buildRankings([{ stationuuid: 'bad' }], [b]), /Invalid/);
    });
    await test('failed rating refresh keeps previous snapshot and date while updating catalog', async () => {
        const folder = fs.mkdtempSync(path.join(root, '..', 'ranking-test-'));
        const targets = { catalog: path.join(folder, 'stations.json'), rankings: path.join(folder, 'rankings.json') };
        const previous = JSON.stringify(buildRankings([{ stationuuid: 'a', votes: 0, clickcount: 1 }], [{ stationuuid: 'a', votes: 0, clickcount: 1 }], '2026-09-30T00:00:00Z'));
        fs.writeFileSync(targets.rankings, previous);
        try {
            const raw = Array.from({ length: 1001 }, (_, i) => ({ stationuuid: String(i), name: 'Radio', url_stream: `https://example.com/${i}` }));
            await updateCatalog(async url => {
                if (url.endsWith('.gz')) return gzipSync(JSON.stringify(raw));
                throw new Error('API unavailable');
            }, targets);
            assert.equal(fs.readFileSync(targets.rankings, 'utf8'), previous);
            assert.equal(JSON.parse(fs.readFileSync(targets.catalog)).stations.length, 1001);
        } finally {
            for (const file of Object.values(targets)) if (fs.existsSync(file)) fs.unlinkSync(file);
            fs.rmdirSync(folder);
        }
    });
    await test('GitHub ratings order top votes and keep unranked stations distinct from zero', async () => {
        const stations = Array.from({ length: 1001 }, (_, i) => ({ stationuuid: `id-${i}`, name: `Radio ${i}`, url_resolved: `https://example.com/${i}` }));
        const rankings = buildRankings([
            { stationuuid: 'id-1', votes: 50, clickcount: 90 },
            { stationuuid: 'id-2', votes: 100, clickcount: 20 },
            { stationuuid: 'id-3', votes: 0, clickcount: 0 }
        ], [
            { stationuuid: 'id-2', votes: 100, clickcount: 20 },
            { stationuuid: 'id-1', votes: 50, clickcount: 90 },
            { stationuuid: 'id-3', votes: 0, clickcount: 0 }
        ], '2026-10-01T00:00:00Z');
        const rt = runtime({}, async url => url.includes('api.radio-browser.info') ? { ok: false, status: 503 } : { ok: true, json: async () => url.endsWith('rankings.json') ? rankings : { stations } });
        const top = await rt.context.fetchApi('/stations/topvote/100');
        assert.deepEqual(Array.from(top, s => s.stationuuid), ['id-2', 'id-1', 'id-3']);
        const all = await rt.context.fetchApi('/stations/topclick/100');
        assert.equal(all[0].stationuuid, 'id-1');
        assert.equal(all.find(s => s.stationuuid === 'id-0').votes, null);
        assert.equal(all.find(s => s.stationuuid === 'id-3').votes, 0);
        assert.match(rt.nodes.get('catalogSourceStatus').textContent, /рейтинг на/);
        rt.context.switchTab('top-voted');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(vm.runInContext('stations[0].stationuuid', rt.context), 'id-2');
        assert.equal(rt.nodes.get('sortSelect').value, 'votes');
    });
    await test('static catalog serves search, countries and saved stations after API failure', async () => {
        const stations = Array.from({ length: 1001 }, (_, i) => ({ stationuuid: `id-${i}`, name: i === 0 ? 'Jazz One' : `Station ${i}`, url_resolved: `https://example.com/${i}`, country: 'Russia', countrycode: 'RU', tags: i === 0 ? 'jazz' : '' }));
        const rt = runtime({ auraradio_station_cache: JSON.stringify({ missing: { stationuuid: 'missing', name: 'Saved', url_resolved: 'https://example.com/saved' } }) }, url => {
            return Promise.resolve(url.includes('api.radio-browser.info')
                ? { ok: false, status: 503 }
                : { ok: true, json: async () => ({ stations }) });
        });
        assert.equal((await rt.context.fetchApi('/stations/search?name=Jazz&limit=10')).length, 1);
        assert.equal((await rt.context.fetchApi('/countries'))[0].stationcount, 1001);
        assert.equal((await rt.context.fetchApi('/stations/byuuid?uuids=missing'))[0].name, 'Saved');
        assert.equal(rt.requests.filter(url => url.includes('data/stations.json')).length, 1);
        assert.equal(rt.requests.filter(url => url.includes('api.radio-browser.info')).length, 3);
        assert(rt.requests[0].includes('api.radio-browser.info'));
    });
    await test('built-in stations load when API and GitHub are unavailable', async () => {
        const rt = runtime({}, async () => ({ ok: false, status: 503 }));
        const result = await rt.context.fetchApi('/stations/search?name=Relax');
        assert(result.some(station => station.name === 'Relax FM'));
        assert(rt.requests.some(url => url.includes('api.radio-browser.info')));
        assert(rt.requests.some(url => url.includes('data/stations.json')));
    });
    await test('syntax and shared core wiring', () => {
        new vm.Script(app); new vm.Script(read('js/sonara-core.js')); new vm.Script(read('sw.js'));
        for (const pattern of [/js\/sonara-core\.js/, /SonaraCore\.createBackup/, /SonaraCore\.parseBackup/,
            /SonaraCore\.lastStationSource/, /let activeRequestId = 0/, /SonaraCore\.createPlaybackController/]) assert.match(html, pattern);
        assert.doesNotMatch(app, /function (safeNumber|validateCustomStation|countryMatches)\(/);
    });
    await test('theme toggle persists and restores the selected mode', () => {
        const rt = runtime();
        rt.boot();
        assert.equal(rt.context.document.documentElement.dataset.theme, 'dark');
        rt.context.toggleTheme();
        assert.equal(rt.context.document.documentElement.dataset.theme, 'light');
        assert.equal(rt.store.get('auraradio_theme'), 'light');
        assert.equal(rt.nodes.get('themeToggle').title, 'Включить тёмную тему');
        assert.equal(rt.nodes.get('themeToggleIcon').className, 'fa-solid fa-moon');
        const next = runtime({ auraradio_theme: 'light' });
        const initializer = html.match(/<script>\s*try \{([\s\S]*?)<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
        vm.runInContext(initializer, next.context);
        next.boot();
        assert.equal(next.context.document.documentElement.dataset.theme, 'light');
        next.context.toggleTheme();
        assert.equal(next.store.get('auraradio_theme'), 'dark');
    });
    await test('single-file build embeds runtime dependencies', () => {
        const portable = buildStandalone();
        assert.match(portable, /SonaraCore = api/);
        assert.match(portable, /data:application\/octet-stream;base64,/);
        assert.doesNotMatch(portable, /src="(?:js\/sonara-core|vendor\/hls\.min)\.js"/);
        assert.doesNotMatch(portable, /href="manifest\.json"|register\('sw\.js'\)/);
        assert(portable.includes(html.match(/Sonara Radio v\d+\.\d+\.\d+/)[0]));
    });
    await test('storage validation calls production helpers', () => {
        assert.deepEqual(Core.parseStoredStringArray('broken'), []);
        assert.deepEqual(Core.parseStoredStringArray('{}'), []);
        assert.deepEqual(Core.parseStoredStringArray('[" a ","a",null,3,{},""]'), ['a']);
        assert.deepEqual(Core.parseStoredStringArray(JSON.stringify(['x'.repeat(129)])), []);
        assert.deepEqual(Core.parseStoredCustomStations('null'), []);
        const stations = Core.parseStoredCustomStations(JSON.stringify([
            { stationuuid: 'custom_1', name: ' One ', url_resolved: 'https://example.com', junk: 1 },
            { stationuuid: 'custom_1', name: 'Duplicate', url_resolved: 'https://example.com' },
            { stationuuid: 'custom_2', name: '', url_resolved: 'https://example.com' }]));
        assert.equal(stations.length, 1); assert.equal(stations[0].name, 'One'); assert.equal('junk' in stations[0], false);
    });
    await test('backup round trip and legacy import', () => {
        const payload = Core.createBackup([' abc ', 'abc', null], [{ stationuuid: 'custom_1', name: 'Mine', url_resolved: 'https://example.com', junk: 1 }]);
        const result = Core.parseBackup(JSON.stringify(payload));
        assert.equal(payload.version, 3); assert.deepEqual(result.favorites, ['abc']);
        assert.equal(result.customStations.length, 1); assert.equal('junk' in result.customStations[0], false);
        assert.deepEqual(Core.parseBackup('["abc","abc","",null,123,"custom_test"]').favorites, ['abc', 'custom_test']);
        assert.throws(() => Core.parseBackup('{"version":2,"favorites":[],"customStations":[]}'));
    });
    await test('country decisions use production core', () => {
        assert(Core.countryMatches({ country: 'Germany', countrycode: 'DE' }, 'de'));
        assert(!Core.countryMatches({ country: 'Japan', countrycode: 'JP' }, 'de'));
    });
    await test('actual HLS handler stops after bounded recovery', () => {
        const rt = runtime();
        let instance;
        class HlsMock {
            static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
            static ErrorTypes = { NETWORK_ERROR: 'NETWORK_ERROR', MEDIA_ERROR: 'MEDIA_ERROR' };
            static isSupported() { return true; }
            constructor() { instance = this; this.handlers = {}; this.network = 0; this.media = 0; this.destroyed = false; }
            loadSource() {} attachMedia() {} on(event, fn) { this.handlers[event] = fn; }
            startLoad() { this.network++; } recoverMediaError() { this.media++; }
            destroy() { this.destroyed = true; }
        }
        rt.context.Hls = HlsMock;
        rt.context.playStreamUrl('https://example.com/live.m3u8');
        for (let i = 0; i < 3; i++) {
            rt.context.setPlaybackState('playing');
            instance.handlers.error(null, { fatal: true, type: 'NETWORK_ERROR' });
            assert(rt.nodes.get('equalizer').classList.contains('paused-eq'));
            assert(instance.destroyed);
            rt.clock.advance(i === 0 ? 1500 : i === 1 ? 3000 : 0);
        }
        assert.equal(instance.network, 0); assert(instance.destroyed);
        assert.equal(vm.runInContext('isPlaying', rt.context), false);
    });
    await test('runtime bootstrap restores custom station without API lookup', () => {
        const station = { stationuuid: 'custom_1', name: 'Mine', url_resolved: 'https://example.com' };
        const rt = runtime({ auraradio_custom: JSON.stringify([station]), auraradio_last_station: 'custom_1' });
        rt.boot(); assert.equal(rt.nodes.get('playerStationName').textContent, 'Mine');
        rt.context.playStation('custom_1');
        assert.deepEqual(JSON.parse(rt.store.get('auraradio_playHistory')), ['custom_1']);
        assert(!rt.requests.some(url => url.includes('/stations/byuuid/custom_') || url.includes('/url/custom_')));
        const missing = runtime({ auraradio_last_station: 'custom_deleted' });
        missing.boot(); assert(!missing.requests.some(url => url.includes('custom_deleted')));
    });
    await test('actual export and import persist both keys', () => {
        const rt = runtime({ auraradio_favorites: '["one"]', auraradio_custom: JSON.stringify([{ stationuuid: 'custom_1', name: 'Mine', url_resolved: 'https://example.com' }]) });
        rt.context.exportFavorites();
        const anchor = [...rt.nodes.values()].find(node => String(node.download || '').startsWith('sonararadio_backup_'));
        assert(anchor); const payload = JSON.parse(decodeURIComponent(anchor.href.split(',')[1]));
        const other = runtime();
        other.context.importFavorites({ target: { files: [{ text: JSON.stringify(payload) }], value: '' } });
        assert.equal(JSON.parse(other.store.get('auraradio_custom')).length, 1);
        other.context.importFavorites({ target: { files: [{ text: '["legacy"]' }], value: '' } });
        assert(JSON.parse(other.store.get('auraradio_favorites')).includes('legacy'));
    });
    await test('actual loader rejects late Explore response after Favorites', async () => {
        let release;
        const rt = runtime({}, url => url.includes('/stations/topclick/')
            ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => [{ stationuuid: 'late', name: 'Late', url_resolved: 'https://example.com' }] }); })
            : Promise.resolve({ ok: true, json: async () => [] }));
        rt.boot(); rt.context.switchTab('favorites'); release();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(vm.runInContext('currentTab', rt.context), 'favorites');
        assert.equal(rt.nodes.get('stationCount').textContent, '0 станций');
    });
    await test('tab switch cancels pending search debounce', async () => {
        const rt = runtime();
        rt.boot();
        rt.listeners['searchInput:input']({ target: { value: 'jazz' } });
        rt.context.switchTab('favorites');
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.equal(vm.runInContext('currentTab', rt.context), 'favorites');
        assert(!rt.requests.some(url => url.includes('name=jazz')));
    });
    await test('country filter keeps active view and catalog playback works', () => {
        const rt = runtime();
        rt.context.switchTab('favorites');
        rt.context.filterByCountry('DE');
        assert.equal(vm.runInContext('currentTab', rt.context), 'favorites');
        vm.runInContext("stations = [{stationuuid:'catalog_1',name:'Radio',url_resolved:'https://example.com/live',country:'Germany'}]", rt.context);
        rt.context.playStation('catalog_1');
        assert.equal(rt.nodes.get('audioElement').src, 'https://example.com/live');
        assert.deepEqual(JSON.parse(rt.store.get('auraradio_playHistory')), ['catalog_1']);
        assert(rt.requests.some(url => url.includes('/url/catalog_1')));
    });
    await test('real loaders run without ReferenceError', async () => {
        const rt = runtime(); rt.context.switchTab('history'); rt.context.switchTab('genres-list');
        rt.context.searchStations('jazz'); rt.context.filterByTag('rock');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(vm.runInContext('activeRequestId', rt.context) > 0);
    });
    await test('release assets and shutdown scripts', () => {
        const manifest = JSON.parse(read('manifest.json')); assert(manifest.name && manifest.icons.length >= 3);
        for (const size of [192, 256, 512]) { const png = fs.readFileSync(path.join(root, `logo-${size}.png`)); assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size); }
        assert(fs.statSync(path.join(root, 'vendor/hls.min.js')).size > 100000);
        assert.match(read('sw.js'), /js\/sonara-core\.js/);
        assert.doesNotMatch(read('install-shutdown.bat'), /\/s \/f \/t 0/);
        assert.match(read('install-shutdown.bat'), /shutdown \/a/);
        assert.match(read('shutdown-now.vbs'), /shutdown \/a/);
    });
    console.log(`${passed} PASSED, 0 FAILED`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../js/sonara-core.js');
const buildStandalone = require('../scripts/build-standalone.js');
const { buildCatalog } = require('../scripts/update-catalog.js');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const app = html.match(/<!-- JavaScript Application Logic -->\s*<script src="js\/sonara-core\.js"><\/script>\s*<script>([\s\S]*?)<\/script>/)[1];
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }

function runtime(storageData = {}, fetchImpl = async () => ({ ok: true, json: async () => [] })) {
    const nodes = new Map(), listeners = {}, requests = [], store = new Map(Object.entries(storageData));
    function element(id = '') {
        if (nodes.has(id)) return nodes.get(id);
        const classes = new Set();
        const node = { id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', src: '',
            classList: { add: (...x) => x.forEach(v => classes.add(v)), remove: (...x) => x.forEach(v => classes.delete(v)), toggle: x => classes.has(x) ? classes.delete(x) : classes.add(x), contains: x => classes.has(x) },
            addEventListener: (type, fn) => { listeners[id + ':' + type] = fn; },
            appendChild() {}, append() {}, replaceChildren() {}, remove() {}, click() {},
            setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
            getAttribute() { return null; }, play: async () => {}, pause() {}, load() {} };
        nodes.set(id, node); return node;
    }
    const document = { documentElement: { dataset: { theme: 'dark' } }, getElementById: element, createElement: () => element('created' + Math.random()),
        querySelector: () => null, querySelectorAll: () => [], body: element('body'), head: element('head'),
        readyState: 'loading', addEventListener() {} };
    const window = { addEventListener: (type, fn) => { listeners['window:' + type] = fn; } };
    const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
    const context = vm.createContext({ SonaraCore: Core, document, window, localStorage, navigator: {},
        console: { log() {}, warn() {}, error() {} },
        fetch: (...args) => { requests.push(args[0]); return fetchImpl(...args); },
        AbortSignal, URL, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math,
        btoa: str => Buffer.from(str, 'binary').toString('base64'), encodeURIComponent, unescape,
        FileReader: class { readAsText(file) { this.onload({ target: { result: file.text } }); } } });
    vm.runInContext(app, context, { filename: 'index.html' });
    return { context, nodes, listeners, requests, store, boot: () => listeners['window:DOMContentLoaded']() };
}

async function main() {
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
    await test('static catalog serves search, countries and saved stations without live API', async () => {
        const stations = Array.from({ length: 1001 }, (_, i) => ({ stationuuid: `id-${i}`, name: i === 0 ? 'Jazz One' : `Station ${i}`, url_resolved: `https://example.com/${i}`, country: 'Russia', countrycode: 'RU', tags: i === 0 ? 'jazz' : '' }));
        const rt = runtime({ auraradio_station_cache: JSON.stringify({ missing: { stationuuid: 'missing', name: 'Saved', url_resolved: 'https://example.com/saved' } }) }, url => {
            assert(url.includes('data/stations.json'));
            return Promise.resolve({ ok: true, json: async () => ({ stations }) });
        });
        assert.equal((await rt.context.fetchApi('/stations/search?name=Jazz&limit=10')).length, 1);
        assert.equal((await rt.context.fetchApi('/countries'))[0].stationcount, 1001);
        assert.equal((await rt.context.fetchApi('/stations/byuuid?uuids=missing'))[0].name, 'Saved');
        assert.equal(rt.requests.length, 1);
    });
    await test('syntax and shared core wiring', () => {
        new vm.Script(app); new vm.Script(read('js/sonara-core.js')); new vm.Script(read('sw.js'));
        for (const pattern of [/js\/sonara-core\.js/, /SonaraCore\.createBackup/, /SonaraCore\.parseBackup/,
            /SonaraCore\.lastStationSource/, /let activeRequestId = 0/, /SonaraCore\.nextHlsRecoveryAction/]) assert.match(html, pattern);
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
        assert.match(portable, /Sonara Radio v2\.3\.3/);
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
        assert.equal(payload.version, 1); assert.deepEqual(result.favorites, ['abc']);
        assert.equal(result.customStations.length, 1); assert.equal('junk' in result.customStations[0], false);
        assert.deepEqual(Core.parseBackup('["abc","abc","",null,123,"custom_test"]').favorites, ['abc', 'custom_test']);
        assert.throws(() => Core.parseBackup('{"version":2,"favorites":[],"customStations":[]}'));
    });
    await test('country and HLS decisions use production core', () => {
        assert(Core.countryMatches({ country: 'Germany', countrycode: 'DE' }, 'de'));
        assert(!Core.countryMatches({ country: 'Japan', countrycode: 'JP' }, 'de'));
        assert.equal(Core.nextHlsRecoveryAction('NETWORK_ERROR', 0, 0), 'RECOVER_NETWORK');
        assert.equal(Core.nextHlsRecoveryAction('NETWORK_ERROR', 2, 0), 'DESTROY');
        assert.equal(Core.nextHlsRecoveryAction('MEDIA_ERROR', 0, 1), 'DESTROY');
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
        for (let i = 0; i < 3; i++) instance.handlers.error(null, { fatal: true, type: 'NETWORK_ERROR' });
        assert.equal(instance.network, 2); assert(instance.destroyed);
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
        const rt = runtime({}, url => url.includes('/data/stations.json')
            ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ stations: Array.from({ length: 1001 }, (_, i) => ({ stationuuid: String(i), name: 'Late', url_resolved: 'https://example.com' })) }) }); })
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

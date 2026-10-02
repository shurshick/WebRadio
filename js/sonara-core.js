(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.SonaraCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function safeNumber(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    function validateFavoriteUuid(value) {
        if (typeof value !== 'string') return null;
        const clean = value.trim();
        return clean && clean.length <= 128 ? clean : null;
    }

    function normalizeStringArray(input) {
        if (!Array.isArray(input)) return [];
        return [...new Set(input.map(validateFavoriteUuid).filter(Boolean))];
    }

    function normalizeStreamUrls(input) {
        const urls = [];
        for (const value of Array.isArray(input) ? input : []) {
            if (typeof value !== 'string' || value.trim().length > 2048) continue;
            try {
                const url = new URL(value.trim());
                if (!['http:', 'https:'].includes(url.protocol) || urls.includes(url.href)) continue;
                urls.push(url.href);
            } catch {}
            if (urls.length === 6) break;
        }
        return urls;
    }
    function stationStreamUrls(station) {
        return normalizeStreamUrls([station?.url_resolved, ...(Array.isArray(station?.alternate_urls) ? station.alternate_urls : []), station?.url]);
    }
    function normalizeStreamOverrides(input) {
        const entries = new Map();
        for (const item of Array.isArray(input) ? input : []) {
            const stationuuid = validateFavoriteUuid(item?.stationuuid);
            const urls = normalizeStreamUrls(item?.urls);
            if (stationuuid && urls.length) entries.set(stationuuid, { stationuuid, urls });
        }
        return [...entries.values()];
    }

    function validateCustomStation(s) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
        const stationuuid = validateFavoriteUuid(s.stationuuid);
        if (!stationuuid || !stationuuid.startsWith('custom_')) return null;
        if (typeof s.name !== 'string' || !s.name.trim() || s.name.trim().length > 256) return null;
        if (typeof s.url_resolved !== 'string' || !s.url_resolved.trim() || s.url_resolved.trim().length > 2048) return null;
        try { if (!['http:', 'https:'].includes(new URL(s.url_resolved.trim()).protocol)) return null; } catch { return null; }
        const optional = (key, max, fallback = '') => typeof s[key] === 'string' ? s[key].trim().slice(0, max) : fallback;
        return {
            stationuuid, name: s.name.trim(), url_resolved: s.url_resolved.trim(),
            alternate_urls: stationStreamUrls(s).filter(url => url !== normalizeStreamUrls([s.url_resolved])[0]),
            favicon: optional('favicon', 2048), country: optional('country', 128, 'Local'),
            state: optional('state', 128), codec: optional('codec', 32).toUpperCase(),
            bitrate: safeNumber(s.bitrate), tags: optional('tags', 512, 'custom'),
            votes: null, clickcount: null
        };
    }

    function normalizeCustomStations(input) {
        if (!Array.isArray(input)) return [];
        const seen = new Set();
        return input.map(validateCustomStation).filter(station => {
            if (!station || seen.has(station.stationuuid)) return false;
            seen.add(station.stationuuid);
            return true;
        });
    }

    function parseStoredStringArray(raw) {
        try { return normalizeStringArray(JSON.parse(raw)); } catch (_) { return []; }
    }

    function parseStoredCustomStations(raw) {
        try { return normalizeCustomStations(JSON.parse(raw)); } catch (_) { return []; }
    }

    function normalizeSavedStations(input) {
        const seen = new Set();
        return (Array.isArray(input) ? input : []).map(s => {
            if (!s || typeof s !== 'object') return null;
            const id = validateFavoriteUuid(s.stationuuid);
            const url = typeof s.url_resolved === 'string' ? s.url_resolved.trim() : '';
            if (!id || seen.has(id) || typeof s.name !== 'string' || !s.name.trim() || !/^https?:\/\//i.test(url) || url.length > 2048) return null;
            seen.add(id);
            const result = { stationuuid: id, name: s.name.trim().slice(0, 256), url_resolved: url };
            result.alternate_urls = stationStreamUrls(s).slice(1);
            for (const key of ['favicon', 'tags', 'country', 'countrycode', 'state', 'codec']) result[key] = typeof s[key] === 'string' ? s[key].slice(0, key === 'favicon' ? 2048 : 512) : '';
            result.bitrate = safeNumber(s.bitrate);
            for (const key of ['votes', 'clickcount']) result[key] = typeof s[key] === 'number' && Number.isFinite(s[key]) && s[key] >= 0 ? s[key] : null;
            return result;
        }).filter(Boolean);
    }

    function createBackup(favorites, customStations, savedStations = [], streamOverrides = []) {
        const ids = normalizeStringArray(favorites);
        const custom = normalizeCustomStations(customStations);
        const included = new Set([...ids, ...custom.map(s => s.stationuuid)]);
        return { version: 3, favorites: ids, customStations: custom,
            savedStations: normalizeSavedStations(savedStations).filter(s => ids.includes(s.stationuuid)),
            streamOverrides: normalizeStreamOverrides(streamOverrides).filter(s => included.has(s.stationuuid)) };
    }

    function parseBackup(raw) {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(data)) return { favorites: normalizeStringArray(data), customStations: [], savedStations: [], streamOverrides: [], legacy: true };
        if (!data || ![1, 2, 3].includes(data.version) || !Array.isArray(data.favorites) || !Array.isArray(data.customStations) || (data.version >= 2 && !Array.isArray(data.savedStations)) || (data.version === 3 && !Array.isArray(data.streamOverrides))) {
            throw new Error('Unsupported backup format');
        }
        const favorites = normalizeStringArray(data.favorites);
        return { favorites, customStations: normalizeCustomStations(data.customStations),
            savedStations: normalizeSavedStations(data.savedStations).filter(s => favorites.includes(s.stationuuid)), streamOverrides: normalizeStreamOverrides(data.streamOverrides), legacy: false };
    }

    const COUNTRY_ALIASES = {
        ru: 'ru', russia: 'ru', 'russian federation': 'ru', 'россия': 'ru', 'российская федерация': 'ru',
        us: 'us', usa: 'us', 'united states': 'us', 'united states of america': 'us',
        de: 'de', germany: 'de', deutschland: 'de', fr: 'fr', france: 'fr', 'франция': 'fr',
        gb: 'gb', uk: 'gb', 'united kingdom': 'gb', 'great britain': 'gb', england: 'gb', britain: 'gb',
        it: 'it', italy: 'it', italia: 'it', 'италия': 'it', es: 'es', spain: 'es', espana: 'es', 'испания': 'es',
        ca: 'ca', canada: 'ca', 'канада': 'ca', ua: 'ua', ukraine: 'ua', 'украина': 'ua'
    };
    function countryMatches(st, country) {
        if (!country) return true;
        const key = country.toLowerCase().trim();
        const cc = (st.countrycode || '').toLowerCase().trim();
        if (cc === key) return true;
        const target = COUNTRY_ALIASES[key] || null;
        const cname = (st.country || '').toLowerCase().trim();
        const stationCode = (cc && COUNTRY_ALIASES[cc]) || (cname && COUNTRY_ALIASES[cname]) || null;
        if (target && stationCode) return target === stationCode;
        if (target) return cname !== '' && cname.includes(key);
        return cname !== '' && (cname.includes(key) || (key.length > 3 && key.includes(cname)));
    }

    function lastStationSource(savedId, customStations) {
        if (!savedId) return { kind: 'none' };
        if (!savedId.startsWith('custom_')) return { kind: 'catalog', id: savedId };
        const station = customStations.find(s => s.stationuuid === savedId);
        return station ? { kind: 'custom', station } : { kind: 'none' };
    }

    function createPlaybackController(options) {
        const schedule = options.setTimeout || setTimeout;
        const cancel = options.clearTimeout || clearTimeout;
        const delays = options.retryDelays || [1500, 3000];
        let urls = [], index = 0, retries = 0, token = 0, phase = 'stopped';
        let reconnectTimer, timeoutTimer, stableTimer;
        function clearTimers() {
            for (const timer of [reconnectTimer, timeoutTimer, stableTimer]) if (timer != null) cancel(timer);
            reconnectTimer = timeoutTimer = stableTimer = null;
        }
        function notify(state, extra = {}) {
            options.onState(state, { url: urls[index], address: index + 1, total: urls.length, retries, token, ...extra });
        }
        function current(value) { return value === token && ['connecting', 'playing', 'buffering'].includes(phase); }
        function armTimeout(duration) {
            if (timeoutTimer != null) cancel(timeoutTimer);
            const attemptToken = token;
            timeoutTimer = schedule(() => fail(attemptToken, 'timeout'), duration);
        }
        function connect() {
            clearTimers();
            token++;
            phase = 'connecting';
            options.disconnect();
            notify('loading');
            armTimeout(options.connectTimeout || 12000);
            try { options.connect(urls[index], token); } catch { fail(token, 'network'); }
        }
        function start(input) {
            clearTimers(); token++; phase = 'stopped'; options.disconnect();
            urls = normalizeStreamUrls(input); index = retries = 0;
            if (!urls.length) { phase = 'failed'; notify('failed', { reason: 'invalid' }); return; }
            connect();
        }
        function fail(attemptToken, reason = 'network') {
            if (!current(attemptToken)) return;
            clearTimers(); token++; phase = 'backoff'; options.disconnect();
            if (reason === 'blocked') { phase = 'failed'; notify('failed', { reason }); return; }
            let delay;
            if (reason !== 'unsupported' && retries < delays.length) {
                delay = delays[retries++];
                notify('retrying', { delay, reason });
            } else if (index + 1 < urls.length) {
                index++; retries = 0; delay = delays[0] || 1500;
                notify('switching', { delay, reason });
            } else {
                phase = 'failed'; notify('failed', { reason }); return;
            }
            const pendingToken = token;
            reconnectTimer = schedule(() => { if (phase === 'backoff' && token === pendingToken) connect(); }, delay);
        }
        function playing(attemptToken = token) {
            if (!current(attemptToken)) return;
            if (timeoutTimer != null) cancel(timeoutTimer);
            timeoutTimer = null;
            phase = 'playing'; notify('playing');
            if (stableTimer == null) stableTimer = schedule(() => {
                stableTimer = null;
                if (current(attemptToken) && phase === 'playing') { retries = 0; options.onStable?.(); }
            }, options.stableDuration || 30000);
        }
        function waiting(attemptToken = token) {
            if (!current(attemptToken) || phase === 'connecting' || phase === 'buffering') return;
            if (stableTimer != null) cancel(stableTimer);
            stableTimer = null; phase = 'buffering'; notify('loading');
            armTimeout(options.bufferTimeout || 15000);
        }
        function stop(state = 'stopped') {
            clearTimers(); token++; phase = 'stopped';
            if (state !== 'ended') options.disconnect();
            notify(state);
        }
        return { start, fail, playing, waiting, stop, isCurrent: current,
            snapshot: () => ({ phase, token, url: urls[index], address: index + 1, retries }) };
    }

    function createCatalogStore(indexedDB) {
        async function transact(mode, value) {
            if (!indexedDB) return null;
            return new Promise(resolve => {
                let db, tx, result = null, done = false;
                const finish = output => {
                    if (done) return;
                    done = true; clearTimeout(timer);
                    if (db) db.close();
                    resolve(output);
                };
                const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(null); }, 3000);
                try {
                    const request = indexedDB.open('sonara-radio', 1);
                    request.onupgradeneeded = () => request.result.createObjectStore('catalog');
                    request.onerror = request.onblocked = () => finish(null);
                    request.onsuccess = () => {
                        db = request.result;
                        if (done) { db.close(); return; }
                        try {
                            tx = db.transaction('catalog', mode);
                            const store = tx.objectStore('catalog');
                            const operation = mode === 'readonly' ? store.get('snapshot') : store.put(value, 'snapshot');
                            operation.onsuccess = () => { result = mode === 'readonly' ? operation.result : true; };
                            tx.oncomplete = () => finish(result);
                            tx.onerror = tx.onabort = () => finish(null);
                        } catch { finish(null); }
                    };
                } catch { finish(null); }
            });
        }
        return { read: () => transact('readonly'), write: value => transact('readwrite', value) };
    }

    return { safeNumber, validateFavoriteUuid, normalizeStringArray, validateCustomStation,
        normalizeCustomStations, parseStoredStringArray, parseStoredCustomStations,
        normalizeSavedStations, normalizeStreamUrls, stationStreamUrls, normalizeStreamOverrides, createPlaybackController,
        createBackup, parseBackup, countryMatches, lastStationSource, createCatalogStore };
});

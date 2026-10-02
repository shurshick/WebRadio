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
            for (const key of ['favicon', 'tags', 'country', 'countrycode', 'state', 'codec']) result[key] = typeof s[key] === 'string' ? s[key].slice(0, key === 'favicon' ? 2048 : 512) : '';
            result.bitrate = safeNumber(s.bitrate);
            for (const key of ['votes', 'clickcount']) result[key] = typeof s[key] === 'number' && Number.isFinite(s[key]) && s[key] >= 0 ? s[key] : null;
            return result;
        }).filter(Boolean);
    }

    function createBackup(favorites, customStations, savedStations = []) {
        const ids = normalizeStringArray(favorites);
        return { version: 2, favorites: ids, customStations: normalizeCustomStations(customStations),
            savedStations: normalizeSavedStations(savedStations).filter(s => ids.includes(s.stationuuid)) };
    }

    function parseBackup(raw) {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(data)) return { favorites: normalizeStringArray(data), customStations: [], savedStations: [], legacy: true };
        if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.favorites) || !Array.isArray(data.customStations) || (data.version === 2 && !Array.isArray(data.savedStations))) {
            throw new Error('Unsupported backup format');
        }
        const favorites = normalizeStringArray(data.favorites);
        return { favorites, customStations: normalizeCustomStations(data.customStations),
            savedStations: normalizeSavedStations(data.savedStations).filter(s => favorites.includes(s.stationuuid)), legacy: false };
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

    function nextHlsRecoveryAction(type, networkAttempts, mediaAttempts) {
        if (type === 'NETWORK_ERROR' && networkAttempts < 2) return 'RECOVER_NETWORK';
        if (type === 'MEDIA_ERROR' && mediaAttempts < 1) return 'RECOVER_MEDIA';
        return 'DESTROY';
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
        normalizeSavedStations, createBackup, parseBackup, countryMatches, lastStationSource, nextHlsRecoveryAction, createCatalogStore };
});

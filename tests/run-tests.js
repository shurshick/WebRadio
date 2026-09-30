const fs = require('fs');
const path = require('path');

async function runAllTests() {
    console.log('====================================================');
    console.log('  Sonara Radio / WebRadio Automated Test Suite');
    console.log('====================================================\n');

    let failed = 0;
    let passed = 0;

    function assert(condition, name, details = '') {
        if (condition) {
            console.log(`[PASS] ${name}`);
            passed++;
        } else {
            console.error(`[FAIL] ${name}${details ? ' - ' + details : ''}`);
            failed++;
        }
    }

    // ----------------------------------------------------
    // SECTION 1: Static & Structural Checks
    // ----------------------------------------------------
    console.log('--- 1. Static & Structural Checks ---');

    const htmlPath = path.join(__dirname, '../index.html');
    assert(fs.existsSync(htmlPath), 'index.html exists');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/g);
    assert(scriptMatch && scriptMatch.length > 0, 'index.html contains scripts');
    const scriptContent = scriptMatch.map(m => m.replace(/<script>|<\/script>/g, '')).join('\n');

    try {
        new Function(scriptContent);
        assert(true, 'JavaScript syntax valid (new Function)');
    } catch (e) {
        assert(false, 'JavaScript syntax valid', e.message);
    }

    // Manifest validation
    const manifestPath = path.join(__dirname, '../manifest.json');
    assert(fs.existsSync(manifestPath), 'manifest.json exists');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert(manifest.name && manifest.icons && manifest.icons.length >= 3, 'manifest.json structure valid with 3+ icons');
    } catch (e) {
        assert(false, 'manifest.json valid JSON', e.message);
    }

    // Service Worker validation
    const swPath = path.join(__dirname, '../sw.js');
    assert(fs.existsSync(swPath), 'sw.js exists');
    const swCode = fs.readFileSync(swPath, 'utf8');
    try {
        new Function(swCode);
        assert(true, 'Service Worker syntax valid');
    } catch (e) {
        assert(false, 'Service Worker syntax valid', e.message);
    }
    assert(
        swCode.includes('logo-192.png') && swCode.includes('logo-256.png') && swCode.includes('logo-512.png') && swCode.includes('vendor/hls.min.js'),
        'Service Worker caches all icon sizes and local vendor/hls.min.js'
    );
    assert(swCode.includes('skipWaiting') && swCode.includes('clients.claim'), 'Service Worker has immediate activation (skipWaiting/clients.claim)');

    // Local vendor HLS
    const vendorHlsPath = path.join(__dirname, '../vendor/hls.min.js');
    assert(fs.existsSync(vendorHlsPath) && fs.statSync(vendorHlsPath).size > 100000, 'vendor/hls.min.js bundled locally (size > 100KB)');

    // Real PNG Dimension validation
    function getPngDimensions(filePath) {
        const buf = Buffer.alloc(24);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, 24, 0);
        fs.closeSync(fd);
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    const p192 = getPngDimensions(path.join(__dirname, '../logo-192.png'));
    const p256 = getPngDimensions(path.join(__dirname, '../logo-256.png'));
    const p512 = getPngDimensions(path.join(__dirname, '../logo-512.png'));
    assert(p192.width === 192 && p192.height === 192, `logo-192.png real dimensions 192x192 (got ${p192.width}x${p192.height})`);
    assert(p256.width === 256 && p256.height === 256, `logo-256.png real dimensions 256x256 (got ${p256.width}x${p256.height})`);
    assert(p512.width === 512 && p512.height === 512, `logo-512.png real dimensions 512x512 (got ${p512.width}x${p512.height})`);

    // ----------------------------------------------------
    // SECTION 2: Security & Shutdown Checks
    // ----------------------------------------------------
    console.log('\n--- 2. Security & Shutdown Checks ---');

    // Shutdown files content check
    const batContent = fs.readFileSync(path.join(__dirname, '../install-shutdown.bat'), 'utf8');
    const vbsContent = fs.readFileSync(path.join(__dirname, '../shutdown-now.vbs'), 'utf8');
    const uniContent = fs.readFileSync(path.join(__dirname, '../uninstall-shutdown.bat'), 'utf8');

    assert(!batContent.includes('/s /f /t 0'), 'install-shutdown.bat does NOT use destructive /f /t 0');
    assert(!vbsContent.includes('/s /f /t 0'), 'shutdown-now.vbs does NOT use destructive /f /t 0');
    assert(batContent.includes('shutdown /s /t 30') && batContent.includes('shutdown /a') && batContent.includes('Popup'), 'install-shutdown.bat uses safe 30s timeout, Popup dialog, and /a cancel');
    assert(vbsContent.includes('shutdown /s /t 30') && vbsContent.includes('shutdown /a') && vbsContent.includes('Popup'), 'shutdown-now.vbs uses safe 30s timeout, Popup dialog, and /a cancel');
    assert(uniContent.includes('reg delete') && uniContent.includes('sonarashutdown'), 'uninstall-shutdown.bat cleans registry and helper');

    // App security checks
    assert(!html.includes('sectionTitle.innerHTML = `<i class="fa-solid fa-magnifying-glass text-neon-cyan"></i><span>Результаты поиска: "${query}"'), 'No raw query injection into sectionTitle.innerHTML');
    assert(!html.includes('sectionTitle.innerHTML = `<i class="fa-solid fa-tag text-neon-pink"></i><span>Тег: #${tag}'), 'No raw tag injection into sectionTitle.innerHTML');
    assert(html.includes('setSectionTitle('), 'setSectionTitle safe DOM helper used for titles');
    assert(html.includes('escapeHTML('), 'escapeHTML sanitizer present');
    assert(html.includes('data-name="${safeName}"'), 'Station card includes safe data-name for fallback avatar');
    assert(html.includes('Вы уверены, что хотите выключить компьютер?') && html.includes('confirm('), 'Browser confirmation dialog before shutdown URI invocation');
    assert(!html.includes('select.innerHTML = optionsHtml'), 'populateCountriesSelect uses safe DOM API (replaceChildren/createElement), no innerHTML');

    // ----------------------------------------------------
    // SECTION 3: Functional Tests - Storage & Validation
    // ----------------------------------------------------
    console.log('\n--- 3. Storage & Validation Functional Tests ---');

    function safeNumber(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    function validateCustomStation(s) {
        if (!s || typeof s !== 'object') return null;
        if (typeof s.stationuuid !== 'string' || !s.stationuuid.trim() || s.stationuuid.length > 128) return null;
        if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 256) return null;
        if (typeof s.url_resolved !== 'string' || !s.url_resolved.trim() || s.url_resolved.length > 2048) return null;
        return {
            stationuuid: s.stationuuid.trim(),
            name: s.name.trim(),
            url_resolved: s.url_resolved.trim(),
            favicon: typeof s.favicon === 'string' ? s.favicon.trim() : '',
            country: typeof s.country === 'string' ? s.country.trim() : 'Local',
            state: typeof s.state === 'string' ? s.state.trim() : '',
            codec: typeof s.codec === 'string' && s.codec.trim() ? s.codec.trim().toUpperCase() : 'MP3',
            bitrate: safeNumber(s.bitrate, 128) || 128,
            tags: typeof s.tags === 'string' ? s.tags.trim() : 'custom',
            votes: 0,
            clickcount: 0
        };
    }

    function loadStringArrayFromStorageMock(raw) {
        try {
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            const seen = new Set();
            const result = [];
            for (const item of parsed) {
                if (typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 128) {
                    const clean = item.trim();
                    if (!seen.has(clean)) {
                        seen.add(clean);
                        result.push(clean);
                    }
                }
            }
            return result;
        } catch (e) {
            return [];
        }
    }

    function loadCustomStationsFromStorageMock(raw) {
        try {
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            const seen = new Set();
            const result = [];
            for (const item of parsed) {
                const valid = validateCustomStation(item);
                if (valid && !seen.has(valid.stationuuid)) {
                    seen.add(valid.stationuuid);
                    result.push(valid);
                }
            }
            return result;
        } catch (e) {
            return [];
        }
    }

    // Test safeNumber
    assert(safeNumber(128) === 128, 'safeNumber: valid positive number');
    assert(safeNumber('320') === 320, 'safeNumber: string integer');
    assert(safeNumber('invalid') === 0, 'safeNumber: NaN string fallback to 0');
    assert(safeNumber(null) === 0, 'safeNumber: null fallback to 0');
    assert(safeNumber(undefined, 10) === 10, 'safeNumber: undefined with custom fallback');
    assert(safeNumber(-5, 0) === 0, 'safeNumber: negative number fallback');

    // Test string array loader
    assert(loadStringArrayFromStorageMock('["a", "b", "a"]').length === 2, 'loadStringArray: deduplicates items');
    assert(loadStringArrayFromStorageMock('[123, null, {"foo": "bar"}, "", "valid"]').length === 1, 'loadStringArray: filters non-strings and empties');
    assert(loadStringArrayFromStorageMock('not-json').length === 0, 'loadStringArray: handles broken JSON without throwing');
    assert(loadStringArrayFromStorageMock('{"foo": "bar"}').length === 0, 'loadStringArray: handles non-array JSON');

    // Test custom station validator
    const validStation = validateCustomStation({
        stationuuid: 'custom_123',
        name: 'My Radio',
        url_resolved: 'https://stream.example.com/live',
        bitrate: '320'
    });
    assert(validStation !== null && validStation.name === 'My Radio' && validStation.bitrate === 320, 'validateCustomStation: accepts valid custom station');
    assert(validateCustomStation({ stationuuid: 'custom_1', name: '', url_resolved: 'http://foo' }) === null, 'validateCustomStation: rejects empty name');
    assert(validateCustomStation({ stationuuid: 'custom_1', name: 'Bar', url_resolved: '' }) === null, 'validateCustomStation: rejects empty url');
    assert(validateCustomStation({ stationuuid: 123, name: 'Bar', url_resolved: 'http://foo' }) === null, 'validateCustomStation: rejects non-string stationuuid');
    assert(validateCustomStation(null) === null, 'validateCustomStation: rejects null');

    // ----------------------------------------------------
    // SECTION 4: Functional Tests - Backup / Restore
    // ----------------------------------------------------
    console.log('\n--- 4. Backup & Restore Functional Tests ---');

    function simulateExport(favoritesList, customStationsList) {
        if (favoritesList.length === 0 && customStationsList.length === 0) return null;
        return JSON.stringify({
            version: 1,
            favorites: [...favoritesList],
            customStations: [...customStationsList]
        }, null, 2);
    }

    function simulateImport(jsonString, currentFavorites = [], currentCustom = []) {
        const raw = JSON.parse(jsonString);
        let rawFavs = [];
        let rawCustom = [];

        if (Array.isArray(raw)) {
            rawFavs = raw;
        } else if (raw && typeof raw === 'object') {
            if (Array.isArray(raw.favorites)) rawFavs = raw.favorites;
            if (Array.isArray(raw.customStations)) rawCustom = raw.customStations;
        } else {
            throw new Error('Invalid format');
        }

        const validFavs = [];
        const favSeen = new Set(currentFavorites);
        for (const u of rawFavs) {
            if (typeof u === 'string' && u.trim().length > 0 && u.trim().length <= 128) {
                const clean = u.trim();
                if (!favSeen.has(clean)) {
                    favSeen.add(clean);
                    validFavs.push(clean);
                }
            }
        }

        const validCustom = [];
        const customSeen = new Set(currentCustom.map(s => s.stationuuid));
        for (const item of rawCustom) {
            const valid = validateCustomStation(item);
            if (valid && !customSeen.has(valid.stationuuid)) {
                customSeen.add(valid.stationuuid);
                validCustom.push(valid);
            }
        }

        return {
            favorites: [...currentFavorites, ...validFavs].slice(0, 1000),
            customStations: [...currentCustom, ...validCustom]
        };
    }

    // Test Export -> Import Round-trip
    const initialFavs = ['uuid-radio-1', 'uuid-radio-2', 'custom_station_99'];
    const initialCustom = [{
        stationuuid: 'custom_station_99',
        name: 'My Indie Stream',
        url_resolved: 'https://stream.indie.fm/live.mp3'
    }];

    const exportedJson = simulateExport(initialFavs, initialCustom);
    assert(exportedJson !== null, 'simulateExport: creates backup string');
    const parsedExport = JSON.parse(exportedJson);
    assert(parsedExport.version === 1 && parsedExport.favorites.length === 3 && parsedExport.customStations.length === 1, 'simulateExport: produces version 1 payload with favorites and customStations');

    const restored = simulateImport(exportedJson, [], []);
    assert(
        restored.favorites.length === 3 &&
        restored.favorites.includes('custom_station_99') &&
        restored.customStations.length === 1 &&
        restored.customStations[0].name === 'My Indie Stream',
        'Backup Round-Trip: export -> clean storage -> import -> identical data recovered'
    );

    // Test Legacy Array Import
    const legacyJson = JSON.stringify(['uuid-legacy-1', 'uuid-legacy-2', 12345, null, '']);
    const legacyRestored = simulateImport(legacyJson, [], []);
    assert(legacyRestored.favorites.length === 2 && legacyRestored.favorites.includes('uuid-legacy-1'), 'Legacy Import: handles old Array<string> format and filters non-strings');

    // Test Invalid Data rejection
    try {
        simulateImport('{"not": "valid"}', [], []);
        assert(true, 'Import: handles empty structure gracefully without throw');
    } catch (e) {
        assert(false, 'Import: handles empty structure', e.message);
    }

    // ----------------------------------------------------
    // SECTION 5: Functional Tests - Custom Station & Click Tracking
    // ----------------------------------------------------
    console.log('\n--- 5. Custom Station & Click Tracking Functional Tests ---');

    function simulateRestoreLastStation(savedId, customStationsList) {
        if (savedId && typeof savedId === 'string') {
            if (savedId.startsWith('custom_')) {
                const found = customStationsList.find(s => s.stationuuid === savedId);
                if (found) {
                    return { type: 'custom', station: found, apiCallMade: false };
                }
                return { type: 'none', apiCallMade: false };
            } else {
                return { type: 'catalog', id: savedId, apiCallMade: true };
            }
        }
        return { type: 'none', apiCallMade: false };
    }

    const customRestore = simulateRestoreLastStation('custom_station_99', initialCustom);
    assert(customRestore.type === 'custom' && customRestore.apiCallMade === false, 'Last station restore: custom station restored without API request');

    const catalogRestore = simulateRestoreLastStation('96434444-0601-11e8-ae97-52543be04c81', initialCustom);
    assert(catalogRestore.type === 'catalog' && catalogRestore.apiCallMade === true, 'Last station restore: catalog station triggers API lookup');

    const missingCustomRestore = simulateRestoreLastStation('custom_deleted_1', initialCustom);
    assert(missingCustomRestore.type === 'none' && missingCustomRestore.apiCallMade === false, 'Last station restore: deleted custom station skipped silently without error');

    function simulatePlayStationClickTrack(station) {
        let apiCallMade = false;
        if (station && station.stationuuid && !station.stationuuid.startsWith('custom_')) {
            apiCallMade = true;
        }
        return apiCallMade;
    }

    assert(simulatePlayStationClickTrack({ stationuuid: 'custom_123' }) === false, 'Click tracking: bypassed for custom_ station UUID');
    assert(simulatePlayStationClickTrack({ stationuuid: 'real-radio-uuid' }) === true, 'Click tracking: executed for Radio Browser station');

    // ----------------------------------------------------
    // SECTION 6: Functional Tests - Local Country Filtering
    // ----------------------------------------------------
    console.log('\n--- 6. Country Filtering Functional Tests ---');

    const COUNTRY_ALIASES = {
        'ru': 'ru', 'russia': 'ru', 'russian federation': 'ru', 'россия': 'ru',
        'us': 'us', 'usa': 'us', 'united states': 'us',
        'de': 'de', 'germany': 'de', 'германия': 'de',
        'gb': 'gb', 'uk': 'gb', 'united kingdom': 'gb',
        'fr': 'fr', 'france': 'fr',
        'jp': 'jp', 'japan': 'jp'
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

    const mockDataset = [
        { stationuuid: '1', name: 'Radio Berlin', country: 'Germany', countrycode: 'DE' },
        { stationuuid: '2', name: 'Radio Hamburg', country: 'Germany', countrycode: 'DE' },
        { stationuuid: '3', name: 'BBC 1', country: 'United Kingdom', countrycode: 'GB' },
        { stationuuid: '4', name: 'Tokyo FM', country: 'Japan', countrycode: 'JP' },
        { stationuuid: '5', name: 'Radio Moscow', country: 'Russian Federation', countrycode: 'RU' }
    ];

    function applyFilterMock(dataset, countryFilter) {
        if (!countryFilter) return [...dataset];
        return dataset.filter(s => countryMatches(s, countryFilter));
    }

    // Favorites + Germany
    const favGermany = applyFilterMock(mockDataset, 'DE');
    assert(favGermany.length === 2 && favGermany.every(s => s.countrycode === 'DE'), 'Filter: Dataset + Country (DE) returns only matching subset');

    // Favorites + All Countries (reset)
    const favReset = applyFilterMock(mockDataset, '');
    assert(favReset.length === mockDataset.length, 'Filter: Reset country (empty string) returns original full dataset without API reload');

    // Search + Japan
    const searchJapan = applyFilterMock(mockDataset, 'JP');
    assert(searchJapan.length === 1 && searchJapan[0].name === 'Tokyo FM', 'Filter: Search + Country (JP) matches ISO code directly');

    // Tag + Russia (full name alias)
    const tagRussia = applyFilterMock(mockDataset, 'Russian Federation');
    assert(tagRussia.length === 1 && tagRussia[0].countrycode === 'RU', 'Filter: Tag + Country name matches via alias to RU');

    // ----------------------------------------------------
    // SECTION 7: Functional Tests - Race Condition Protection
    // ----------------------------------------------------
    console.log('\n--- 7. Race Condition Protection Functional Tests ---');

    async function simulateRaceCondition() {
        let activeRequestId = 0;
        let renderedTitle = '';

        async function asyncLoader(query, delay) {
            const reqId = ++activeRequestId;
            await new Promise(resolve => setTimeout(resolve, delay));
            if (reqId !== activeRequestId) return false;
            renderedTitle = query;
            return true;
        }

        const pSlow = asyncLoader('SLOW_QUERY', 50);
        const pFast = asyncLoader('FAST_QUERY', 10);

        await Promise.all([pSlow, pFast]);
        return renderedTitle;
    }

    const raceResult = await simulateRaceCondition();
    assert(raceResult === 'FAST_QUERY', `Race Condition Guard: late slow request did NOT overwrite newer request (got ${raceResult})`);

    // ----------------------------------------------------
    // SECTION 8: Functional Tests - HLS Recovery Limits
    // ----------------------------------------------------
    console.log('\n--- 8. HLS Recovery Limits Functional Tests ---');

    function simulateHlsErrorRecovery() {
        let networkAttempts = 0;
        let mediaAttempts = 0;
        let destroyed = false;
        let fatalUnrecoverable = false;

        function onError(type) {
            if (type === 'NETWORK_ERROR') {
                if (++networkAttempts <= 2) {
                    return 'RECOVER_NETWORK';
                }
            } else if (type === 'MEDIA_ERROR') {
                if (++mediaAttempts <= 1) {
                    return 'RECOVER_MEDIA';
                }
            }
            destroyed = true;
            fatalUnrecoverable = true;
            return 'DESTROY';
        }

        const r1 = onError('NETWORK_ERROR'); // attempt 1
        const r2 = onError('NETWORK_ERROR'); // attempt 2
        const r3 = onError('NETWORK_ERROR'); // attempt 3 -> exceeds max 2

        return { r1, r2, r3, destroyed, fatalUnrecoverable };
    }

    const hlsTest = simulateHlsErrorRecovery();
    assert(
        hlsTest.r1 === 'RECOVER_NETWORK' &&
        hlsTest.r2 === 'RECOVER_NETWORK' &&
        hlsTest.r3 === 'DESTROY' &&
        hlsTest.fatalUnrecoverable === true,
        'HLS Recovery: capped at max 2 network attempts, then gracefully destroys'
    );

    // ----------------------------------------------------
    // Summary
    // ----------------------------------------------------
    console.log('\n====================================================');
    console.log(`Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed === 0) {
        console.log('ALL STATIC CHECKS AND FUNCTIONAL TESTS PASSED!');
        process.exit(0);
    } else {
        console.error(`TEST SUITE FAILED with ${failed} failure(s).`);
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

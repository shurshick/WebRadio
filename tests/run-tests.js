const fs = require('fs');
const path = require('path');

console.log('--- Running Sonara Radio Automated Test Suite ---');
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name}`);
        failed++;
    }
}

// 1. Check index.html exists & syntax
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
    assert(false, 'JavaScript syntax valid: ' + e.message);
}

// 2. Validate manifest.json
const manifestPath = path.join(__dirname, '../manifest.json');
assert(fs.existsSync(manifestPath), 'manifest.json exists');
try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.name && manifest.icons && manifest.icons.length >= 2, 'manifest.json structure valid');
} catch (e) {
    assert(false, 'manifest.json valid JSON: ' + e.message);
}

// 3. Validate sw.js
const swPath = path.join(__dirname, '../sw.js');
assert(fs.existsSync(swPath), 'sw.js exists');
const swCode = fs.readFileSync(swPath, 'utf8');
try {
    new Function(swCode);
    assert(true, 'Service Worker syntax valid');
} catch (e) {
    assert(false, 'Service Worker syntax valid: ' + e.message);
}
assert(swCode.includes('logo-192.png') && swCode.includes('logo-512.png'), 'Service Worker caches all icon sizes');
assert(swCode.includes('skipWaiting') && swCode.includes('clients.claim'), 'Service Worker has immediate activation');

// 4. Validate Icons
const icon192 = path.join(__dirname, '../logo-192.png');
const icon256 = path.join(__dirname, '../logo-256.png');
const icon512 = path.join(__dirname, '../logo-512.png');
assert(fs.existsSync(icon192) && fs.statSync(icon192).size > 10000, 'logo-192.png exists and non-empty');
assert(fs.existsSync(icon256) && fs.statSync(icon256).size > 10000, 'logo-256.png exists and non-empty');
assert(fs.existsSync(icon512) && fs.statSync(icon512).size > 10000, 'logo-512.png exists and non-empty');
assert(fs.statSync(icon192).size !== fs.statSync(icon256).size, 'logo-192.png and logo-256.png are different files');

// 5. Security & XSS checks
assert(!html.includes('sectionTitle.innerHTML = `<i class="fa-solid fa-magnifying-glass text-neon-cyan"></i><span>Результаты поиска: "${query}"'), 'No raw query injection into sectionTitle.innerHTML');
assert(!html.includes('sectionTitle.innerHTML = `<i class="fa-solid fa-tag text-neon-pink"></i><span>Тег: #${tag}'), 'No raw tag injection into sectionTitle.innerHTML');
assert(html.includes('setSectionTitle('), 'setSectionTitle safe helper used');
assert(html.includes('escapeHTML('), 'escapeHTML sanitizer present');
assert(html.includes('data-name="${safeName}"'), 'Station card includes safe data-name for fallback avatar');

// 6. Shutdown safety checks
assert(html.includes('Вы уверены, что хотите выключить компьютер?') && html.includes('confirm('), 'Browser confirmation dialog before shutdown URI invocation');
assert(!html.includes('shell.Run "shutdown /s /f /t 0"'), 'No silent unconfirmed shutdown /f /t 0 in generated installer');
assert(html.includes('shutdown /s /t 30'), 'Shutdown timer allows 30s delay for user safety');

// 7. Data management & context checks
assert(html.includes('activeRequestId'), 'Network race condition guard (activeRequestId) present');
assert(html.includes('clearTimeout(searchTimeout)'), 'searchTimeout cleared on tab switch');
assert(html.includes("currentTab === 'history') loadHistory();"), 'reloadCurrentView supports history tab');
assert(html.includes('customStations: customStations'), 'Backup includes customStations');

// Summary
console.log('-------------------------------------------------');
if (failed === 0) {
    console.log('ALL TESTS PASSED! Ready for production release.');
    process.exit(0);
} else {
    console.error(`TEST SUITE FAILED with ${failed} failure(s).`);
    process.exit(1);
}

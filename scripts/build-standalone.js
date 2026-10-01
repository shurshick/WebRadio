const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function buildStandalone() {
    let html = read('index.html').replace(/\r\n/g, '\n');
    function replaceOnce(oldText, newText) {
        if (html.split(oldText).length !== 2) throw new Error(`Expected one occurrence: ${oldText.slice(0, 80)}`);
        html = html.replace(oldText, newText);
    }

    const hls = read('vendor/hls.min.js');
    const core = read('js/sonara-core.js');
    if (/<\/script/i.test(hls) || /<\/script/i.test(core)) throw new Error('Inline script terminator in dependency');
    replaceOnce(
        '<script src="vendor/hls.min.js" onerror="this.onerror=null;this.src=\'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js\'"></script>',
        `<script>\n${hls}\n</script>`
    );
    replaceOnce('<script src="js/sonara-core.js"></script>', `<script>\n${core}\n</script>`);
    replaceOnce('    <link rel="manifest" href="manifest.json">\n', '');
    replaceOnce(`        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js').catch(err => console.log('SW ref failed', err));
            });
        }
`, '');
    const installer = fs.readFileSync(path.join(root, 'install-shutdown.bat')).toString('base64');
    replaceOnce("a.href = 'install-shutdown.bat';", `a.href = 'data:application/octet-stream;base64,${installer}';`);
    return html;
}

if (require.main === module) {
    const output = process.argv[2];
    if (!output) throw new Error('Usage: node scripts/build-standalone.js <output-path>');
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, buildStandalone());
    console.log(path.resolve(output));
}

module.exports = buildStandalone;

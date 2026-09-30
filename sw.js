const CACHE_NAME = 'sonara-radio-v2';
const ASSETS = [
    'index.html',
    'manifest.json',
    'logo-256.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', event => {
    // Only intercept local requests for the app shell, not API calls or audio streams
    if (event.request.method !== 'GET' || event.request.url.includes('api.radio-browser.info') || event.request.url.match(/\.(m3u8|aac|mp3|ogg|aacp)$/i)) {
        return;
    }
    
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request).catch(() => {
                // Return index.html for navigation requests if offline
                if (event.request.mode === 'navigate') {
                    return caches.match('index.html');
                }
            });
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
});

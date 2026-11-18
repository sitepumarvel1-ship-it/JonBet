// Mode statis = versi GitHub Pages: tidak ada server. Data dibaca dari berkas JSON hasil build,
// model dan JonBet AI dijalankan di browser, tebakan disimpan di perangkat.
// Penanda dipasang oleh scripts/build-pages.mjs ke index.html; di server biasa tidak ada.
export const STATIC = document.querySelector('meta[name="jonbet-mode"]')?.getAttribute('content') === 'static';

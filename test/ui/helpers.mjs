import { createRequire } from 'node:module';
import { createApp } from '../../server/app.js';

// Playwright dicari di proyek ini dulu, lalu di lokasi alat global (lingkungan pengembangan).
function loadPlaywright() {
  for (const base of [import.meta.url, '/opt/npm-tools/node_modules/']) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return createRequire(base)(name); } catch { /* coba kemungkinan berikutnya */ }
    }
  }
  throw new Error('Playwright tidak ditemukan. Pasang dengan: npm i --no-save playwright-core');
}
export const { chromium } = loadPlaywright();

export async function startServer(opts = {}) {
  const app = createApp({ dbPath: ':memory:', provider: 'demo', log: () => {}, rateLimitPerMinute: 100000, authRateLimitPerMinute: 1000, aiRateLimitPerMinute: 100000, writeRateLimitPerMinute: 100000, ...opts });
  const port = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

/** Pasang pengumpul galat konsol / CSP / permintaan gagal pada halaman. */
export function watch(page) {
  const issues = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) issues.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => issues.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => issues.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) issues.push(`[http ${r.status()}] ${r.url()}`); });
  return issues;
}

export { startStaticSite } from '../../scripts/static-site.mjs';

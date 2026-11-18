import { startServer, launch, watch } from './helpers.mjs';
const out = process.argv[2] || '/home/claude/shots';
const srv = await startServer();
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
const page = await ctx.newPage();
const issues = watch(page);
await page.goto(srv.base + '/');
await page.waitForSelector('.live-strip, .empty, .error-box', { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/m-home.png`, fullPage: false });
await page.screenshot({ path: `${out}/m-home-full.png`, fullPage: true });

await page.goto(srv.base + '/#/matches');
await page.waitForSelector('.league, .empty', { timeout: 10000 });
await page.screenshot({ path: `${out}/m-matches.png` });

// buka laga live pertama
await page.goto(srv.base + '/#/matches?status=live&sport=football');
await page.waitForTimeout(600);
const first = await page.$('a.row');
if (first) { await first.click(); await page.waitForSelector('.hero'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/m-match.png` });
  await page.screenshot({ path: `${out}/m-match-full.png`, fullPage: true });
}
console.log(issues.join('\n') || 'tidak ada isu konsol');
await browser.close(); await srv.close();

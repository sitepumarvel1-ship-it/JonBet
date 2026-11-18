// Uji UI end-to-end dengan Chrome headless (Playwright). Jalankan: npm run test:ui
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, launch, watch } from './helpers.mjs';

const OUT = process.env.SHOTS || fileURLToPath(new URL('../../test-results/ui', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const warnings = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ok   ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log(`  GAGAL ${name}\n        ${String(e.message || e).split('\n').slice(0, 6).join('\n        ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert gagal'); }

const srv = await startServer();
const browser = await launch();
const base = srv.base;

const PROFILES = {
  'ponsel-390': { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'ponsel-kecil-320': { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'tablet-768': { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'laptop-1100': { viewport: { width: 1100, height: 800 } },
  'desktop-1440': { viewport: { width: 1440, height: 900 } },
  'lebar-1920': { viewport: { width: 1920, height: 1080 } },
};
const newCtx = (p = 'ponsel-390', extra = {}) => browser.newContext({ ...PROFILES[p], locale: 'id-ID', timezoneId: 'Asia/Jakarta', serviceWorkers: 'allow', ...extra });

async function ready(page, hash = '/') {
  await page.goto(`${base}/#${hash}`);
  await page.waitForSelector('main .page', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('main .loading, main .skeleton'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);
}
const noIssues = (issues, label) => { const real = issues.filter((i) => !/favicon/.test(i)); assert(real.length === 0, `${label}: isu konsol/jaringan:\n${real.join('\n')}`); };

/** Pemeriksaan umum tiap halaman: overflow horizontal, nama aksesibel, teks mentah "undefined/NaN", kontras. */
async function audit(page, label) {
  const r = await page.evaluate(() => {
    const out = { overflow: null, unnamed: [], bad: [], lowContrast: [], tiny: [], imgs: [] };
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > de.clientWidth + 1 && getComputedStyle(e).position !== 'fixed')
        .filter((e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; } return true; })
        .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`);
      out.overflow = { sw: de.scrollWidth, cw: de.clientWidth, wide };
    }
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = (e) => {
      if (e.getAttribute('aria-label')) return true;
      if (e.getAttribute('aria-labelledby')) return !!document.getElementById(e.getAttribute('aria-labelledby'))?.textContent.trim();
      if (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) return true;
      if (e.closest('label')) return true;
      if (e.getAttribute('title')) return true;
      return !!(e.textContent || '').trim() || !!e.querySelector('img[alt]:not([alt=""])');
    };
    for (const e of document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab]')) {
      if (!vis(e)) continue;
      if (e.tagName === 'INPUT' && e.type === 'hidden') continue;
      if (!name(e)) out.unnamed.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`);
      const r = e.getBoundingClientRect();
      if (r.height < 30 && !e.closest('p, .note, .sub, small, nav.nav, .nav-foot, .sr-only') && !e.matches('.sr-only') && e.tagName !== 'INPUT' && !e.matches('.range')) out.tiny.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 25)} ${Math.round(r.height)}px "${(e.textContent || '').trim().slice(0, 18)}"`);
    }
    for (const im of document.querySelectorAll('img')) if (!im.hasAttribute('alt')) out.imgs.push(im.src.slice(-30));
    const text = document.querySelector('main')?.innerText || '';
    for (const w of ['undefined', 'NaN', 'null', '[object', 'Infinity']) if (text.includes(w)) out.bad.push(w);

    // kontras (perkiraan): latar = leluhur terdekat yang berlatar solid
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (e) => { for (let p = e; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c.a > 0.95) return c; } return { r: 12, g: 14, b: 31, a: 1 }; };
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; const t = n.textContent.trim(); const e = n.parentElement;
      if (!t || !e || seen.has(e) || !vis(e) || e.closest('svg, script, style, [aria-hidden=true]')) continue;
      seen.add(e);
      const cs = getComputedStyle(e); const fg = parse(cs.color); const bg = bgOf(e);
      if (!fg || !bg || fg.a < 0.99 || (e.closest('button, a, input') && e.closest('button, a, input').disabled)) continue;
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (ratio < need) out.lowContrast.push(`${ratio.toFixed(2)}<${need} "${t.slice(0, 24)}" ${e.tagName.toLowerCase()}.${String(e.className).slice(0, 20)}`);
    }
    return out;
  });
  assert(!r.overflow, `${label}: meluber horizontal ${JSON.stringify(r.overflow)}`);
  assert(r.unnamed.length === 0, `${label}: kontrol tanpa nama aksesibel: ${r.unnamed.slice(0, 5).join(', ')}`);
  assert(r.bad.length === 0, `${label}: teks mentah mencurigakan: ${r.bad.join(', ')}`);
  assert(r.imgs.length === 0, `${label}: img tanpa alt: ${r.imgs.join(', ')}`);
  if (r.lowContrast.length) warnings.push(`${label}: kontras rendah (${r.lowContrast.length}): ${r.lowContrast.slice(0, 4).join(' | ')}`);
  if (r.tiny.length) warnings.push(`${label}: target sentuh kecil: ${r.tiny.slice(0, 3).join(' | ')}`);
  return r;
}

async function firstHref(page, selector) { return page.$eval(selector, (a) => a.getAttribute('href')); }

/* ------------------------------------------------------------------ uji */

for (const [pname] of Object.entries(PROFILES)) {
  await test(`[${pname}] semua halaman termuat tanpa galat, tanpa meluber, aksesibel`, async () => {
    const ctx = await newCtx(pname); const page = await ctx.newPage(); const issues = watch(page);
    try {
      const live = await (await fetch(`${base}/api/matches?status=live`)).json();
      const up = await (await fetch(`${base}/api/matches?status=upcoming&sport=basketball`)).json();
      const fin = await (await fetch(`${base}/api/matches?status=finished&sport=tennis`)).json();
      const routes = ['/', '/matches', '/matches?status=live', '/community', '/me', '/about', `/match/${encodeURIComponent(live.matches[0].id)}`, `/match/${encodeURIComponent(up.matches[0].id)}`, `/match/${encodeURIComponent(fin.matches[0].id)}`, '/zzz-tidak-ada'];
      for (const r of routes) {
        await ready(page, r);
        await audit(page, `${pname} ${r}`);
        if (['/', '/matches', '/about', '/community'].includes(r)) await page.screenshot({ path: `${OUT}/${pname}${r === '/' ? '-home' : r.replace(/\W+/g, '-')}.png` });
      }
      for (const tab of ['form', 'statistik', 'komunitas', 'ai']) {
        await ready(page, `/match/${encodeURIComponent(live.matches[0].id)}?tab=${tab}`);
        await audit(page, `${pname} tab ${tab}`);
      }
      noIssues(issues, pname);
    } finally { await ctx.close(); }
  });
}

await test('navigasi: tab bawah / rail menandai halaman aktif dan berpindah halaman', async () => {
  for (const pname of ['ponsel-390', 'desktop-1440']) {
    const ctx = await newCtx(pname); const page = await ctx.newPage(); const issues = watch(page);
    await ready(page, '/');
    const nav = pname === 'ponsel-390' ? '.tabbar' : '.nav';
    for (const [label, hash] of [['Pertandingan', '#/matches'], ['Komunitas', '#/community'], ['Profil', '#/me'], ['Beranda', '#/']]) {
      await page.click(`${nav} .tab:has-text("${label}")`);
      await page.waitForFunction((h) => location.hash === h || (h === '#/' && (location.hash === '' || location.hash === '#/')), hash);
      await page.waitForSelector('main .page');
      // aria-current diperbarui saat router selesai merender (event hashchange itu asinkron), sedangkan hash berubah seketika dan .page lama masih ada:
      // tunggu penanda berpindah dulu agar tidak membaca nilai halaman sebelumnya.
      await page.waitForFunction(([n, l]) => document.querySelector(`${n} .tab[aria-current="page"]`)?.textContent.includes(l), [nav, label], { timeout: 4000 }).catch(() => {});
      const cur = await page.$eval(`${nav} .tab[aria-current="page"]`, (e) => e.textContent.trim());
      assert(cur.includes(label), `${pname}: aria-current seharusnya ${label}, dapat ${cur}`);
    }
    const hidden = await page.$eval(pname === 'ponsel-390' ? '.nav' : '.tabbar', (e) => getComputedStyle(e).display);
    assert(hidden === 'none', `${pname}: navigasi sebaliknya harus tersembunyi (${hidden})`);
    noIssues(issues, pname);
    await ctx.close();
  }
});

await test('panel samping desktop menampilkan laga live dan bisa diklik', async () => {
  const ctx = await newCtx('desktop-1440'); const page = await ctx.newPage(); const issues = watch(page);
  await ready(page, '/');
  await page.waitForSelector('.side .row');
  const n = await page.$$eval('.side .row', (r) => r.length);
  assert(n >= 1, 'panel samping kosong');
  const names = await page.$$eval('.side .row .teams .t span:first-child', (els) => els.map((e) => ({ t: e.textContent, w: e.getBoundingClientRect().width, sw: e.scrollWidth })));
  assert(names.every((x) => x.w > 60), `nama tim terpotong: ${JSON.stringify(names)}`);
  await page.click('.side .row');
  await page.waitForSelector('.hero');
  assert(page.url().includes('#/match/'), 'tidak berpindah ke detail');
  noIssues(issues, 'side');
  await ctx.close();
});

await test('jadwal: filter cabang, status, pencarian, tanggal; keadaan kosong & atur ulang', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage(); const issues = watch(page);
  await ready(page, '/matches');
  const all = await page.$$eval('.row', (r) => r.length);
  assert(all > 3, 'jadwal kosong');
  await page.click('.chip:has-text("Basket")');
  await page.waitForTimeout(400);
  const leagues = await page.$$eval('.league-head span:nth-child(2)', (e) => e.map((x) => x.textContent));
  assert(leagues.length && leagues.every((l) => /basket/i.test(l) || /Pasifik/.test(l)), `liga bukan basket: ${leagues}`);
  await page.click('.chip:has-text("Semua")');
  await page.waitForTimeout(300);
  await page.fill('input.search', 'zzzxxqq');
  await page.waitForSelector('.empty', { timeout: 5000 });
  await page.click('button:has-text("Atur ulang filter")');
  await page.waitForSelector('.row');
  await page.fill('input.search', 'komodo');
  await page.waitForTimeout(700);
  const found = await page.$$eval('.row', (r) => r.map((x) => x.textContent.toLowerCase()));
  assert(found.length > 0 && found.every((t) => t.includes('komodo')), 'pencarian "komodo" tidak menyaring');
  await page.fill('input.search', '');
  await page.waitForTimeout(500);
  const segs = await page.$$('.seg button');
  assert(segs.length >= 3, 'segmen status kurang');
  await segs[1].click();
  await page.waitForTimeout(400);
  const dates = await page.$$('.date-btn');
  assert(dates.length >= 3, 'strip tanggal kurang');
  await dates[dates.length - 1].click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ponsel-jadwal-filter.png` });
  noIssues(issues, 'jadwal');
  await ctx.close();
});

await test('detail laga: semua tab, bagan, tabel alternatif, tooltip', async () => {
  const ctx = await newCtx('desktop-1440'); const page = await ctx.newPage(); const issues = watch(page);
  const m = (await (await fetch(`${base}/api/matches?status=upcoming&sport=football`)).json()).matches[0];
  await ready(page, `/match/${encodeURIComponent(m.id)}`);
  await page.waitForSelector('.hero');
  const hero = await page.$eval('.hero', (e) => e.textContent);
  assert(hero.includes(m.home.name) && hero.includes(m.away.name), 'hero tidak memuat nama tim');
  await page.screenshot({ path: `${OUT}/desktop-detail.png`, fullPage: true });
  for (const [id, expect] of [['tab-form', /Form|Pertemuan|H2H/i], ['tab-statistik', /Statistik|statistik/], ['tab-komunitas', /Tebakan|tebakan/], ['tab-ai', /JonBet AI/]]) {
    await page.click(`#${id}`);
    await page.waitForTimeout(350);
    assert((await page.getAttribute(`#${id}`, 'aria-selected')) === 'true', `${id} tidak terpilih`);
    const txt = await page.$eval('#tabpanel', (e) => e.innerText);
    assert(expect.test(txt), `${id}: isi panel tidak sesuai: ${txt.slice(0, 80)}`);
    assert(page.url().includes('tab='), 'tab tidak tercermin di URL');
  }
  await page.click('#tab-analisis');
  // heatmap: ada sel dan tombol tabel
  const cells = await page.$$eval('.heat [role=gridcell], .heat .cell, .heat > *', (e) => e.length);
  assert(cells > 10, `heatmap hanya ${cells} elemen`);
  const toggle = await page.$('button:has-text("Lihat sebagai tabel")');
  if (toggle) { await toggle.click(); await page.waitForSelector('table'); const rows = await page.$$eval('table tr', (r) => r.length); assert(rows > 3, 'tabel skor kosong'); await page.click('button:has-text("Lihat sebagai heatmap"), button:has-text("Lihat sebagai bagan")').catch(() => {}); }
  // tooltip pada batang
  const bar = await page.$('.bars [data-tip], .prob-bar [data-tip], .bars > *');
  if (bar) { await bar.hover(); await page.waitForTimeout(150); }
  // arahkan tab dengan URL langsung ?tab=ai
  await ready(page, `/match/${encodeURIComponent(m.id)}?tab=ai`);
  assert((await page.getAttribute('#tab-ai', 'aria-selected')) === 'true', 'tab dari URL tidak terbuka');
  noIssues(issues, 'detail');
  await ctx.close();
});

await test('tabel/ikon: tombol heatmap-tabel dapat dioperasikan dengan keyboard', async () => {
  const ctx = await newCtx('desktop-1440'); const page = await ctx.newPage();
  const m = (await (await fetch(`${base}/api/matches?status=upcoming&sport=football`)).json()).matches[0];
  await ready(page, `/match/${encodeURIComponent(m.id)}`);
  const btn = await page.$('button:has-text("Lihat sebagai tabel")');
  assert(btn, 'tombol tabel tidak ada');
  await btn.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('table');
  await ctx.close();
});

await test('JonBet AI: bertanya, jawaban muncul, saran bisa diklik, tolak taruhan, input panjang dibatasi', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage(); const issues = watch(page);
  const m = (await (await fetch(`${base}/api/matches?status=live`)).json()).matches[0];
  await ready(page, `/match/${encodeURIComponent(m.id)}?tab=ai`);
  await page.waitForSelector('.chat-form');
  const before = await page.$$eval('.bubble', (b) => b.length);
  await page.fill('.chat-form input', 'Siapa yang lebih berpeluang menang?');
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.bubble.ai').length > n && !/sedang menulis/.test(document.querySelector('.bubble.ai:last-of-type')?.textContent || ''), before, { timeout: 8000 });
  const last = await page.$eval('.bubble.ai:last-of-type', (e) => e.textContent);
  assert(/%/.test(last), `jawaban tanpa persentase: ${last}`);
  const sug = await page.$('.sugg button');
  assert(sug, 'tidak ada tombol saran');
  const n1 = await page.$$eval('.bubble', (b) => b.length);
  await sug.click();
  await page.waitForFunction((n) => document.querySelectorAll('.bubble').length >= n + 2, n1, { timeout: 8000 });
  await page.fill('.chat-form input', 'Taruhan berapa yang aman?');
  await page.click('.chat-form button[type=submit]');
  await page.waitForFunction(() => /tidak memberi saran bertaruh/.test(document.body.innerText), null, { timeout: 8000 });
  const maxlen = await page.$eval('.chat-form input', (e) => e.maxLength);
  assert(maxlen === 500, 'maxlength input AI bukan 500');
  await page.screenshot({ path: `${OUT}/ponsel-ai.png` });
  noIssues(issues, 'ai');
  await ctx.close();
});

await test('akun & komunitas: daftar, tebak, ubah, suka oleh pengguna lain, profil, keluar, masuk lagi', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage(); const issues = watch(page);
  const name = 'uji_' + Math.random().toString(36).slice(2, 7);
  const ups = (await (await fetch(`${base}/api/matches?status=upcoming&sport=football`)).json()).matches;
  const m = ups[ups.length - 2];
  await ready(page, `/match/${encodeURIComponent(m.id)}?tab=komunitas`);
  await page.waitForSelector('button:has-text("Daftar")');
  await page.click('#tabpanel button:has-text("Daftar")');
  await page.waitForSelector('dialog[open]');
  assert((await page.textContent('dialog h2')) === 'Buat akun', 'dialog bukan mode daftar');
  // validasi sisi server tampil
  await page.fill('#auth-user', 'ab'); await page.fill('#auth-pass', 'kata-sandi-1'); await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => /3 sampai 20/.test(document.querySelector('dialog .form-msg')?.textContent || ''));
  await page.fill('#auth-user', name); await page.fill('#auth-pass', 'pendek'); await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => /8 sampai 72/.test(document.querySelector('dialog .form-msg')?.textContent || ''));
  await page.fill('#auth-pass', 'kata-sandi-1'); await page.click('dialog button[type=submit]');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  await page.waitForSelector(`.header a:has-text("${name}")`);
  await page.waitForSelector('.pick-btn');
  // kirim tanpa memilih
  await page.click('button:has-text("Kirim tebakan")');
  await page.waitForFunction(() => /Pilih dulu/.test(document.querySelector('.form-msg')?.textContent || ''));
  // pilih tuan rumah + skor tak cocok -> galat server tampil
  await page.click('.pick-btn.h');
  const nums = await page.$$('input[type=number]');
  await nums[0].fill('0'); await nums[1].fill('2');
  await page.fill('textarea', 'Tuan rumah <b>lebih</b> kuat & "stabil"');
  await page.click('button:has-text("Kirim tebakan")');
  await page.waitForFunction(() => /tidak sesuai/.test(document.querySelector('.form-msg')?.textContent || ''));
  await nums[0].fill('2'); await nums[1].fill('1');
  await page.click('button:has-text("Kirim tebakan")');
  await page.waitForSelector('.pred .note');
  const note = await page.$eval('.pred .note', (e) => e.textContent);
  assert(note === 'Tuan rumah <b>lebih</b> kuat & "stabil"', `catatan harus tampil apa adanya: ${note}`);
  assert((await page.$$('.pred .note b')).length === 0, 'HTML dalam catatan dieksekusi!');
  assert(await page.$('button:has-text("Perbarui tebakan")'), 'tombol tidak berubah menjadi Perbarui');
  // pengguna lain menyukai lewat API
  const other = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name + 'x', password: 'kata-sandi-1' }) });
  const cookie = other.headers.get('set-cookie').split(';')[0];
  const preds = await (await fetch(`${base}/api/matches/${encodeURIComponent(m.id)}/community`)).json();
  const mine = preds.items.find((p) => p.user.username === name);
  const lk = await fetch(`${base}/api/predictions/${mine.id}/like`, { method: 'POST', headers: { cookie } });
  assert(lk.status === 200, 'API suka gagal');
  // halaman komunitas & profil
  await ready(page, '/community');
  await page.waitForSelector('.pred');
  await page.screenshot({ path: `${OUT}/ponsel-komunitas.png` });
  await ready(page, '/me');
  await page.waitForFunction((n) => document.body.innerText.includes(n), name);
  await page.screenshot({ path: `${OUT}/ponsel-profil.png` });
  await audit(page, 'profil');
  // keluar
  await page.click('button:has-text("Keluar")');
  await page.waitForSelector('.header button:has-text("Masuk")');
  // masuk lagi
  await page.click('.header button:has-text("Masuk")');
  await page.fill('#auth-user', name); await page.fill('#auth-pass', 'salah-salah-1'); await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => /salah/.test(document.querySelector('dialog .form-msg')?.textContent || ''));
  await page.fill('#auth-pass', 'kata-sandi-1'); await page.click('dialog button[type=submit]');
  await page.waitForSelector(`.header a:has-text("${name}")`);
  // sesi bertahan setelah muat ulang
  await page.reload();
  await page.waitForSelector(`.header a:has-text("${name}")`);
  noIssues(issues.filter((i) => !/\b(400|401|409)\b/.test(i)), 'akun');
  await ctx.close();
});

await test('XSS: catatan dan nama berisi HTML/skrip tidak pernah dieksekusi di UI', async () => {
  const ctx = await newCtx('desktop-1440'); const page = await ctx.newPage(); const issues = watch(page);
  await page.addInitScript(() => { window.__xss = 0; window.alert = () => { window.__xss++; }; });
  const ups = (await (await fetch(`${base}/api/matches?status=upcoming&sport=tennis`)).json()).matches;
  const m = ups[0];
  const r = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'xss_' + Math.random().toString(36).slice(2, 6), password: 'kata-sandi-1' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  await fetch(`${base}/api/matches/${encodeURIComponent(m.id)}/predictions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ pick: 'H', note: '<img src=x onerror="window.__xss++"><script>window.__xss++</script><svg onload="window.__xss++">' }) });
  for (const hash of [`/match/${encodeURIComponent(m.id)}?tab=komunitas`, '/community', `/u/${(await (await fetch(`${base}/api/feed`)).json()).items[0].user.username}`, '/matches?q=%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%2B%2B%3E', '/#/%3Cscript%3E', `/match/%3Cimg%20src=x%20onerror=alert(1)%3E`]) {
    await ready(page, hash).catch(() => {});
    await page.waitForTimeout(500);
  }
  const x = await page.evaluate(() => window.__xss);
  assert(x === 0, `XSS dieksekusi ${x}x`);
  await page.goto(`${base}/#/community`);
  await page.waitForSelector('.pred .note');
  const raw = await page.$$eval('.pred .note', (n) => n.map((e) => e.textContent).join('|'));
  assert(raw.includes('<img src=x'), 'teks catatan harus tampil mentah sebagai teks');
  noIssues(issues.filter((i) => !/404/.test(i)), 'xss');
  await ctx.close();
});

await test('pengaman halaman: hash rusak, rute tak dikenal, dan id laga ngawur tidak membuat layar kosong', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const hash of ['/match/%E0%A4%A', '/match/', '/match/demo:zzz-1-1', '/u/%00', '/u/tidak_ada_pengguna', '/matches?status=ngawur&sport=catur&date=kemarin', '/community?x=1', '/me/../..', '/%', '/matches?q=' + 'a'.repeat(300)]) {
    await page.goto(`${base}/#${hash}`);
    await page.waitForTimeout(350);
    const len = await page.$eval('main', (m) => m.innerText.trim().length);
    assert(len > 10, `layar kosong untuk #${hash}`);
    const shell = await page.$('.header');
    assert(shell, `kerangka hilang untuk #${hash}`);
  }
  assert(errors.length === 0, `pageerror: ${errors.join(' | ')}`);
  await ctx.close();
});

await test('offline: gerbang "butuh internet" tampil, tombol coba lagi memulihkan, jaringan mati total saat awal juga rapi', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage();
  await ready(page, '/');
  await ctx.setOffline(true);
  await page.waitForSelector('.gate', { timeout: 5000 });
  assert(/butuh internet/i.test(await page.textContent('.gate')), 'teks gerbang salah');
  assert((await page.$$('.gate')).length === 1, 'gerbang ganda');
  await page.screenshot({ path: `${OUT}/ponsel-offline.png` });
  await page.click('#gate-retry'); // masih offline -> tetap
  await page.waitForTimeout(500);
  assert(await page.$('.gate'), 'gerbang hilang padahal masih offline');
  await ctx.setOffline(false);
  await page.waitForSelector('.gate', { state: 'detached', timeout: 8000 });
  await ctx.close();
  // mulai dari kondisi offline total (setelah SW terpasang): halaman cangkang tetap terbuka dengan pesan jelas
  const c2 = await newCtx('ponsel-390'); const p2 = await c2.newPage();
  await ready(p2, '/');
  await p2.waitForFunction(() => navigator.serviceWorker?.controller || true);
  await p2.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  await c2.setOffline(true);
  await p2.reload().catch(() => {});
  await p2.waitForSelector('.gate', { timeout: 8000 });
  assert(/internet/i.test(await p2.textContent('.gate')), 'tanpa pesan internet saat buka offline');
  await c2.close();
});

await test('PWA: manifest valid, service worker aktif, ikon, meta iOS/Android, API tidak di-cache', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage(); const issues = watch(page);
  await ready(page, '/');
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cached = [];
    for (const k of keys) for (const r of await (await caches.open(k)).keys()) cached.push(new URL(r.url).pathname);
    const q = (s) => document.querySelector(s)?.getAttribute('content') ?? document.querySelector(s)?.getAttribute('href');
    return {
      scope: reg.scope, state: reg.active?.state, keys, cached,
      manifest: q('link[rel=manifest]'), apple: q('link[rel=apple-touch-icon]'), theme: q('meta[name=theme-color]'), viewport: q('meta[name=viewport]'),
      iosCapable: q('meta[name=apple-mobile-web-app-capable]'), lang: document.documentElement.lang,
    };
  });
  assert(info.state === 'activated', `SW state ${info.state}`);
  assert(info.cached.length >= 20, `cangkang ter-cache hanya ${info.cached.length}`);
  assert(!info.cached.some((p) => p.startsWith('/api/')), 'API tidak boleh ter-cache');
  assert(info.manifest === 'manifest.webmanifest' && info.apple && info.theme && /viewport-fit=cover/.test(info.viewport) && info.iosCapable === 'yes' && info.lang === 'id', JSON.stringify(info));
  const mf = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert(mf.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable') && mf.icons.some((i) => i.sizes === '192x192'), 'ikon manifest kurang');
  assert(mf.start_url === './' && mf.display === 'standalone', 'manifest tidak standalone');
  // SW bekerja untuk muat ulang: data tetap segar dari jaringan
  await page.reload();
  await page.waitForSelector('main .page');
  const ctrl = await page.evaluate(() => !!navigator.serviceWorker.controller);
  assert(ctrl, 'halaman tidak dikendalikan SW setelah muat ulang');
  noIssues(issues, 'pwa');
  await ctx.close();
});

await test('keyboard: tautan lompat, urutan fokus terlihat, dialog ditutup dengan Escape dan fokus kembali', async () => {
  const ctx = await newCtx('desktop-1440'); const page = await ctx.newPage();
  await ready(page, '/');
  await page.keyboard.press('Tab');
  const skip = await page.evaluate(() => document.activeElement?.textContent);
  assert(/Lewati/.test(skip), `Tab pertama bukan tautan lompat: ${skip}`);
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, text: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 25), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none' }; });
    seen.add(f.text);
    assert(f.outline || f.shadow, `fokus tidak terlihat pada ${f.tag} "${f.text}"`);
  }
  assert(seen.size >= 8, `urutan fokus janggal: ${[...seen]}`);
  await page.click('.header button:has-text("Masuk")');
  await page.waitForSelector('dialog[open]');
  const inDialog = await page.evaluate(() => document.activeElement?.closest('dialog') !== null);
  assert(inDialog, 'fokus tidak masuk ke dialog');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog', { state: 'detached' });
  await ctx.close();
});

await test('preferensi sistem: reduced-motion tanpa animasi, mode kontras paksa tidak merusak tata letak', async () => {
  const ctx = await newCtx('ponsel-390', { reducedMotion: 'reduce', forcedColors: 'active' }); const page = await ctx.newPage(); const issues = watch(page);
  await ready(page, '/');
  const anim = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.05 && cs.animationIterationCount !== '1'; }).length);
  assert(anim === 0, `${anim} elemen masih beranimasi berulang`);
  await audit(page, 'forced-colors');
  await page.screenshot({ path: `${OUT}/ponsel-forced-colors.png` });
  noIssues(issues, 'prefs');
  await ctx.close();
});

await test('polling: tampilan laga live menyegarkan skor tanpa menghapus formulir yang sedang diisi', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage(); const issues = watch(page);
  const ups = (await (await fetch(`${base}/api/matches?status=upcoming&sport=football`)).json()).matches;
  await ready(page, `/match/${encodeURIComponent(ups[1].id)}?tab=komunitas`);
  const name = 'poll_' + Math.random().toString(36).slice(2, 6);
  await page.evaluate(async (n) => { await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: n, password: 'kata-sandi-1' }) }); }, name);
  await page.reload();
  await page.waitForSelector('textarea');
  await page.fill('textarea', 'sedang mengetik');
  await page.focus('textarea');
  const calls = await page.evaluate(async () => {
    const { refreshCurrent } = await import('/js/router.js');
    for (let i = 0; i < 3; i++) await refreshCurrent();
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  });
  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => ({ v: document.querySelector('textarea')?.value, f: document.activeElement?.tagName }));
  assert(kept.v === 'sedang mengetik' && kept.f === 'TEXTAREA', `formulir terganggu: ${JSON.stringify(kept)}`);
  noIssues(issues, 'polling');
  await ctx.close();
});

await test('beranda memuat ulang sendiri tanpa kedip dan menampilkan label demo yang jelas', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage(); const issues = watch(page);
  await ready(page, '/');
  assert(/simulasi/i.test(await page.textContent('.status-chip')), 'chip status demo tidak ada');
  assert(await page.$('.notice'), 'pemberitahuan data simulasi tidak ada');
  const before = await page.$$eval('.live-card', (c) => c.length);
  await page.evaluate(async () => { const { refreshCurrent } = await import('/js/router.js'); await refreshCurrent(); });
  await page.waitForTimeout(300);
  const after = await page.$$eval('.live-card', (c) => c.length);
  assert(before === after && after > 0, `kartu live berubah/hilang saat refresh: ${before} -> ${after}`);
  noIssues(issues, 'home');
  await ctx.close();
});

await test('halaman Tentang memuat rekam jejak model berlabel simulasi dan disclaimer', async () => {
  const ctx = await newCtx('ponsel-390'); const page = await ctx.newPage();
  await ready(page, '/about');
  const txt = await page.$eval('main', (e) => e.innerText);
  assert(/bukan saran bertaruh|tidak.*taruhan/i.test(txt), 'tanpa pernyataan bukan saran bertaruh');
  assert(/simulasi/i.test(txt), 'rekam jejak demo tidak diberi label simulasi');
  assert(/Elo/.test(txt), 'tidak menjelaskan metode');
  await ctx.close();
});

/* ----------------------------------------------------------------- hasil */
await browser.close();
await srv.close();
const failed = results.filter((r) => !r.ok);
if (warnings.length) { console.log('\nCatatan (tidak menggagalkan):'); for (const w of [...new Set(warnings)].slice(0, 30)) console.log('  -', w); }
console.log(`\n${results.length - failed.length}/${results.length} uji UI lulus`);
process.exit(failed.length ? 1 : 0);

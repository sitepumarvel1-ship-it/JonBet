// Membangun situs statis untuk GitHub Pages ke folder keluaran (bawaan: dist/).
//
// GitHub Pages hanya menyajikan berkas statis, jadi skrip ini menjalankan layanan JonBet yang sama
// seperti server (sumber data, rating Elo, model, penjelasan) SEKALI, lalu menyimpan hasilnya sebagai JSON:
//   data/config.json, meta.json, matches.json, results.json, record.json, m/<id>.json (analisis per laga)
// Browser membaca berkas itu; model dan JonBet AI dijalankan ulang di browser untuk pertanyaan pengguna.
//
// Pemakaian:  node scripts/build-pages.mjs [--out dist] [--state .pages-state] [--provider auto|espn|thesportsdb|demo]
// Sumber data: auto (bawaan) = ESPN utama + TheSportsDB pelengkap; espn; thesportsdb; demo = data simulasi.
// Lingkungan: PROVIDER, THESPORTSDB_KEY, OUT_DIR, STATE_DIR
// Folder state (database SQLite rating Elo, cache HTTP, data terakhir) harus dipertahankan antar build
// (di GitHub Actions lewat actions/cache) agar model terus belajar dan permintaan ke sumber data hemat.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, CSP } from '../server/app.js';
import { ENDPOINTS as ESPN_LEAGUES, ESPN_ORIGIN } from '../public/js/static/espn.js';
import { createTsdbProvider } from '../server/providers/thesportsdb.js';
import { createEspnProvider } from '../server/providers/espn.js';
import { createCompositeProvider } from '../server/providers/composite.js';
import { SPORTS, publicSport } from '../server/sports.js';
import { DISCLAIMER } from '../server/ai/explainer.js';
import { matchFile } from '../public/js/static/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FREE_KEYS = new Set(['1', '2', '3', '123']);

/** Cakupan data: dari 2 hari lalu sampai 5 hari ke depan (tampilan "kemarin" sampai "+4 hari" tercakup di zona waktu mana pun). */
export const WINDOW = { before: 2 * DAY, after: 5 * DAY };

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

/** Bulatkan angka desimal ke 5 digit agar berkas lebih kecil (selisih tak terlihat di tampilan). */
const round5 = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v);

/* ------------------------------------------------------------------ fetch hemat */

const isEmptyBoard = (body) => { try { const j = JSON.parse(body); return Array.isArray(j?.events) && j.events.length === 0; } catch { return false; } };

// Umur cache balasan ESPN per hari (hanya permintaan satu hari; rentang tidak di-cache). Hari ini dan kemarin/besok selalu segar;
// hasil 2-4 hari lalu sudah final; jadwal 2+ hari ke depan jarang berubah. Hari yang lebih tua (riwayat rating) tidak disimpan: terlalu besar.
export const espnTtlRule = (url, nowMs) => {
  const m = /\/scoreboard\?dates=(\d{8})$/.exec(url);
  if (!m) return 0;
  const day = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8));
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const d = Math.round((day - today) / DAY);
  if (d >= -4 && d <= -2) return 12 * HOUR;
  if (d >= 2 && d <= 9) return HOUR;
  return 0;
};

/**
 * Pembungkus fetch untuk TheSportsDB: cache di disk (berkas kunci eventsday dipakai ulang antar build sesuai umur
 * tanggalnya), jeda antar permintaan nyata (kunci gratis dibatasi ±30 permintaan/menit), dan coba ulang singkat.
 */
export function makeFetch({ fetchImpl = globalThis.fetch, cacheFile = null, now = () => Date.now(), gapMs = 2200, retries = 2, retryDelayMs = 4000, sleep = sleepMs, stats = {}, ttlRule = null, emptyTtl = 0 } = {}) {
  const cache = cacheFile ? readJson(cacheFile, {}) : {};
  let lastStart = 0;
  let queue = Promise.resolve();
  stats.network = 0; stats.cached = 0; stats.failed = 0; stats.ok = 0; stats.fallback = 0;

  const ttlOf = (url) => {
    if (ttlRule) return ttlRule(url, now());
    const m = /eventsday\.php\?d=(\d{4}-\d{2}-\d{2})/.exec(url);
    if (!m) return 0; // livescore, lookupevent: tidak di-cache
    const dayDiff = Math.round((Date.parse(`${m[1]}T00:00:00Z`) - Date.parse(`${new Date(now()).toISOString().slice(0, 10)}T00:00:00Z`)) / DAY);
    if (dayDiff === 0) return 5 * 60_000; // hari ini: selalu segar tiap build
    if (dayDiff === -1) return 30 * 60_000; // kemarin: laga lewat tengah malam masih bisa berubah
    if (dayDiff < -1) return 12 * HOUR; // hasil lama sudah final
    if (dayDiff === 1) return 30 * 60_000;
    return 3 * HOUR; // jauh ke depan: jadwal jarang berubah
  };

  const gate = () => {
    // Antrean berurutan supaya jeda antar permintaan nyata terjaga walau provider memanggil paralel.
    const run = queue.then(async () => {
      const wait = lastStart + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    queue = run.catch(() => {});
    return run;
  };

  const fn = async (url, init) => {
    const ttl = ttlOf(url);
    const hit = cache[url];
    // Balasan kosong (liga sedang libur) boleh dipakai lebih lama daripada balasan berisi: emptyTtl.
    const limit = hit?.e ? Math.max(ttl, emptyTtl) : ttl;
    if (limit && hit && now() - hit.at < limit) { stats.cached++; return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json' } }); }

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(retryDelayMs * attempt);
      await gate();
      try {
        stats.network++;
        const res = await fetchImpl(url, init);
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const body = await res.text();
        if (res.ok) stats.ok++;
        if (res.ok && (ttl || emptyTtl)) {
          const e = emptyTtl ? isEmptyBoard(body) : false;
          if (ttl || e) cache[url] = { at: now(), body, ...(e ? { e: 1 } : {}) };
        }
        return new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        lastErr = err;
      }
    }
    stats.failed++;
    if (hit) { stats.fallback++; return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json' } }); } // lebih baik data lama daripada kosong
    throw lastErr || new Error('permintaan gagal');
  };

  fn.save = () => {
    if (!cacheFile) return;
    const keep = {};
    for (const [u, v] of Object.entries(cache)) if (now() - v.at < 3 * DAY) keep[u] = v;
    writeJson(cacheFile, keep);
  };
  return fn;
}

/* ------------------------------------------------------------------ data */

const rank = { live: 0, upcoming: 1, finished: 2 };

async function collect(app, t, { maxBundles }) {
  const { service, history } = app;
  const from = t - WINDOW.before;
  const to = t + WINDOW.after;
  const { matches: raw, meta } = await service.fetchList({ from, to, sports: null });
  const listed = (await service.list({ from, to, sports: null, status: 'all', limit: 100000 })).matches;

  // Batas jumlah berkas: utamakan live, lalu jadwal terdekat, lalu hasil terbaru.
  const order = (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
    || (a.status === 'finished' ? Date.parse(b.kickoff) - Date.parse(a.kickoff) : Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const kept = [...listed].sort(order).slice(0, maxBundles);
  const keptIds = new Set(kept.map((m) => m.id));
  const rawById = new Map(raw.map((m) => [m.id, m]));

  const files = new Map();
  const seenFiles = new Set();
  for (const m of kept) {
    const f = matchFile(m.id);
    if (!f) continue; // id di luar format yang dikenal: lewati
    if (seenFiles.has(f)) throw new Error(`Nama berkas bentrok untuk ${m.id}`);
    seenFiles.add(f);
    const src = rawById.get(m.id);
    if (!src) continue;
    files.set(f, service.bundleOf(src));
  }
  const matches = kept.filter((m) => files.has(matchFile(m.id)));

  const health = service.health();
  const demo = !!health.demo;
  const results = { finished: {}, cancelled: [] };
  for (const r of app.db.prepare('SELECT match_id, hs, as_ FROM results WHERE played_at >= ?').all(t - 14 * DAY)) results.finished[r.match_id] = [r.hs, r.as_];
  for (const m of raw) if (m.status === 'cancelled' && keptIds.has(m.id)) results.cancelled.push(m.id);

  const src = demo ? 'demo' : 'real';
  const record = { demo, all: history.modelRecord(null, src), sports: Object.fromEntries(SPORTS.map((s) => [s.id, history.modelRecord(s.id, src)])) };

  return { matches, meta, files, results, record, health, demo };
}

function writeData(dataDir, t, snap, { provider, stale = false, lastError = null, fallbackActive = false, sources = null }) {
  const builtAt = new Date(t).toISOString();
  const demo = snap.demo;
  const dir = (f) => path.join(dataDir, f);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'm'), { recursive: true });

  writeJson(dir('config.json'), {
    name: 'JonBet', demo, provider, fallbackActive, ai: 'builtin',
    sports: SPORTS.map(publicSport), disclaimer: DISCLAIMER,
  });
  writeJson(dir('meta.json'), {
    ok: true, builtAt, provider, demo, fallbackActive, stale, lastError, ai: 'builtin',
    results: snap.health.results, matches: snap.matches.length,
    ...(sources ? { sources } : {}),
  });
  fs.writeFileSync(dir('matches.json'), JSON.stringify({ builtAt, meta: { ...snap.meta, demo, stale, fallback: fallbackActive }, matches: snap.matches }, round5));
  writeJson(dir('results.json'), { builtAt, ...snap.results });
  fs.writeFileSync(dir('record.json'), JSON.stringify(snap.record, round5));
  for (const [f, bundle] of snap.files) {
    const target = dir(f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(bundle, round5));
  }
}

/** Tandai data lama sebagai "tertunda" bila build kali ini gagal mengambil data baru. */
function markStale(dataDir, lastError, t) {
  const metaFile = path.join(dataDir, 'meta.json');
  const meta = readJson(metaFile);
  writeJson(metaFile, { ...meta, stale: true, staleSince: meta.staleSince || meta.builtAt, lastError: String(lastError).slice(0, 500), checkedAt: new Date(t).toISOString() });
  const mf = path.join(dataDir, 'matches.json');
  const m = readJson(mf);
  if (m) writeJson(mf, { ...m, meta: { ...m.meta, stale: true } });
}

/* ------------------------------------------------------------------ situs */

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out.sort();
}

export const SHARED_FILES = ['util.js', 'sports.js', 'ai/explainer.js', 'model/model.js'];

function copySite(outDir) {
  fs.cpSync(path.join(ROOT, 'public'), outDir, { recursive: true });
  // Kode yang sama dipakai server dan browser (penjelasan AI, model, daftar cabang); satu sumber kebenaran.
  const shared = path.join(outDir, 'js', 'shared');
  for (const rel of SHARED_FILES) {
    fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'server', rel), path.join(shared, rel));
  }
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

  // Versi service worker mengikuti isi berkas: tidak berubah bila kode tidak berubah.
  const hash = crypto.createHash('sha1');
  for (const f of listFiles(outDir)) { hash.update(path.relative(outDir, f)); hash.update(fs.readFileSync(f)); }
  const version = `p${hash.digest('hex').slice(0, 10)}`;
  const swFile = path.join(outDir, 'sw.js');
  const sw = fs.readFileSync(swFile, 'utf8');
  if (!/const VERSION = '[^']*';/.test(sw)) throw new Error('VERSION tidak ditemukan di sw.js');
  fs.writeFileSync(swFile, sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`));

  // GitHub Pages tidak bisa memasang header, jadi CSP dan penanda mode dipasang lewat <meta>.
  // frame-ancestors tidak berlaku lewat <meta> (diabaikan browser dengan peringatan), jadi dibuang.
  // connect-src ditambah satu asal: sumber skor langsung (ESPN) yang dipanggil dari browser.
  const csp = CSP.split('; ')
    .filter((d) => !d.startsWith('frame-ancestors'))
    .map((d) => (d.startsWith('connect-src ') ? `${d} ${ESPN_ORIGIN}` : d))
    .join('; ');
  const idx = path.join(outDir, 'index.html');
  const html = fs.readFileSync(idx, 'utf8');
  if (!html.includes('<meta charset="utf-8" />')) throw new Error('meta charset tidak ditemukan di index.html');
  fs.writeFileSync(idx, html.replace('<meta charset="utf-8" />',
    `<meta charset="utf-8" />\n  <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  <meta name="jonbet-mode" content="static" />`));
  return version;
}

/* ------------------------------------------------------------------ utama */

/**
 * @returns {Promise<{outDir, outcome: 'fresh'|'stale'|'demo', matches: number, version: string, error?: string}>}
 */
export async function buildPages({
  outDir = path.join(ROOT, 'dist'),
  stateDir = path.join(ROOT, '.pages-state'),
  provider = 'auto',
  key = '3',
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  log = (...a) => console.log(...a),
  gapMs,
  espnGapMs,
  retryDelayMs,
  sleep,
  maxBundles = 1500,
  backfillDays = 14,
  espnBackfillChunks = 4, // x 15 hari = 60 hari riwayat hasil dari ESPN (satu permintaan per liga per potongan)
  backfillBudgetMs = 8 * 60_000,
} = {}) {
  if (!['auto', 'espn', 'thesportsdb', 'demo'].includes(provider)) throw new Error(`Sumber data tidak dikenal: "${provider}" (pilihan: auto, espn, thesportsdb, demo)`);
  outDir = path.resolve(outDir);
  stateDir = path.resolve(stateDir);
  if (outDir === ROOT || outDir === path.parse(outDir).root || outDir.split(path.sep).length < 3) throw new Error(`Folder keluaran tidak aman: ${outDir}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const version = copySite(outDir);
  const dataDir = path.join(outDir, 'data');
  const lastDir = path.join(stateDir, 'last-data');
  const t = now();

  /* ---- demo: tanpa jaringan dan tanpa state ---- */
  if (provider === 'demo') {
    const app = createApp({ dbPath: ':memory:', provider: 'demo', now, log: () => {} });
    try {
      const snap = await collect(app, t, { maxBundles });
      writeData(dataDir, t, snap, { provider: 'demo' });
    } finally { await app.close(); }
    log(`Build demo selesai: ${fs.readdirSync(path.join(dataDir, 'm')).length} pertandingan.`);
    return { outDir, outcome: 'fresh', matches: fs.readdirSync(path.join(dataDir, 'm')).length, version };
  }

  /* ---- data nyata ---- */
  const tsdbStats = {};
  const espnStats = {};
  const tsdbFetch = makeFetch({ fetchImpl, cacheFile: path.join(stateDir, 'http-cache.json'), now, gapMs: gapMs ?? (FREE_KEYS.has(String(key)) ? 2200 : 0), retryDelayMs, sleep, stats: tsdbStats });
  // ESPN tidak dibatasi seketat kunci gratis TheSportsDB: jeda pendek, coba ulang sekali, tanpa cache disk (respons besar dan cepat basi).
  const espnFetch = makeFetch({ fetchImpl, cacheFile: path.join(stateDir, 'espn-cache.json'), now, gapMs: espnGapMs ?? gapMs ?? 120, retries: 1, retryDelayMs: retryDelayMs ?? 1500, sleep, stats: espnStats, ttlRule: espnTtlRule, emptyTtl: 2 * HOUR });
  const tsdb = createTsdbProvider({ key, fetchImpl: tsdbFetch, now, perMinute: 1e9, timeoutMs: 20_000 });
  const espn = createEspnProvider({ fetchImpl: espnFetch, now, timeoutMs: 20_000, log: (...a) => log('[espn]', ...a) });
  const primary = provider === 'thesportsdb' ? tsdb : provider === 'espn' ? espn : createCompositeProvider({ primary: espn, secondary: tsdb, log: (...a) => log('[sumber]', ...a) });
  let upstream = null; // alasan asli kegagalan sumber (pesan HTTP 502 ke pengguna sengaja umum)
  const app = createApp({ dbPath: path.join(stateDir, 'jonbet.db'), provider, fallbackDemo: false, primaryProvider: primary, now, log: (...a) => { if (a[0] === 'sumber data gagal:') upstream = String(a[1]); log('[sumber]', ...a); } });
  const used = provider === 'thesportsdb' ? [tsdbStats] : provider === 'espn' ? [espnStats] : [tsdbStats, espnStats];
  const sum = (k) => used.reduce((n, x) => n + (x[k] || 0), 0);

  let error = null;
  try {
    const deadline = Date.now() + backfillBudgetMs;

    // 1) Riwayat hasil dari ESPN (untuk rating Elo): potongan 15 hari, dari yang terlama; dilanjutkan di build berikutnya bila waktu habis.
    if (provider !== 'thesportsdb') {
      const file = path.join(stateDir, 'backfill-espn.json');
      let next = readJson(file, { next: espnBackfillChunks }).next;
      while (next >= 1 && Date.now() < deadline) {
        try { app.history.ingestMany(await espn.listMatches({ from: t - next * 15 * DAY, to: t - (next - 1) * 15 * DAY, sports: null })); } catch (e) { log('Riwayat ESPN potongan', next, 'gagal:', e.message); break; }
        next--;
        writeJson(file, { next });
      }
    }

    // 2) Riwayat hasil TheSportsDB per hari (kunci gratis dibatasi permintaannya). Pada mode auto hanya untuk cabang yang tidak dicakup ESPN,
    //    agar rating satu tim tidak terpecah dua oleh perbedaan penulisan nama antar sumber.
    if (provider !== 'espn') {
      const espnSports = new Set(ESPN_LEAGUES.map((e) => e.sport));
      const only = provider === 'auto' ? SPORTS.map((x) => x.id).filter((id) => !espnSports.has(id)) : null;
      const bfFile = path.join(stateDir, 'backfill.json');
      let next = readJson(bfFile, { next: backfillDays }).next;
      while (next >= 1 && Date.now() < deadline) {
        const dayStart = t - next * DAY;
        try { app.history.ingestMany(await tsdb.listMatches({ from: dayStart - 12 * HOUR, to: dayStart + 12 * HOUR, sports: only })); } catch (e) { log('Riwayat hari ke-', next, 'gagal:', e.message); break; }
        next--;
        writeJson(bfFile, { next });
      }
    }

    const snap = await collect(app, t, { maxBundles });
    // Jika setiap permintaan nyata gagal, data yang terkumpul hanya dari cache lama: jangan tampilkan sebagai data baru.
    if (sum('network') > 0 && sum('ok') === 0) throw new Error(`Sumber data tidak merespons (${sum('failed')} permintaan gagal)`);
    const rep = espn.report;
    const sources = {
      mode: provider,
      ...(provider !== 'thesportsdb' ? { espn: rep ? { leagues: rep.tried, ok: rep.ok, events: rep.events, failed: rep.failed.slice(0, 20).map((f) => f.path), rangeSuspect: rep.rangeSuspect, mode: rep.mode } : null } : {}),
      ...(provider !== 'espn' ? { thesportsdb: { requests: tsdbStats.network, cached: tsdbStats.cached, failed: tsdbStats.failed } } : {}),
    };
    writeData(dataDir, t, snap, { provider, sources });
    fs.rmSync(lastDir, { recursive: true, force: true });
    fs.cpSync(dataDir, lastDir, { recursive: true });
    const bySource = snap.matches.reduce((o, m) => { o[m.source] = (o[m.source] || 0) + 1; return o; }, {});
    log(`Data nyata: ${snap.matches.length} pertandingan (${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')}), ${snap.health.results} hasil di riwayat.`);
    if (rep) log(`ESPN: ${rep.ok} dari ${rep.tried} liga merespons${rep.failed.length ? `; gagal: ${rep.failed.slice(0, 8).map((f) => f.path).join(', ')}${rep.failed.length > 8 ? ', ...' : ''}` : ''}.`);
    if (rep?.mode && rep.mode !== 'range') log(`ESPN: memakai mode permintaan "${rep.mode}" (bentuk rentang tanggal ditolak ESPN).`);
    if (rep?.rangeSuspect) log(`ESPN: ${rep.rangeSuspect} liga tampaknya mengabaikan rentang tanggal (hanya satu hari yang kembali); diambil per hari.`);
    log(`Permintaan: ${sum('network')} jaringan, ${sum('cached')} dari cache, ${sum('failed')} gagal (${sum('fallback')} dipulihkan dari cache lama).`);
  } catch (err) {
    error = err;
  } finally {
    tsdbFetch.save();
    espnFetch.save();
    await app.close(); // menutup SQLite dengan rapi (menggabungkan berkas WAL ke database)
  }
  if (!error) return { outDir, outcome: 'fresh', matches: fs.readdirSync(path.join(dataDir, 'm')).length, version };

  let msg = String(error?.message || error);
  if (upstream && !msg.includes(upstream)) msg = `${msg} [${upstream}]`;
  const espnFail = espn.report?.failed?.length ? ` ESPN gagal ${espn.report.failed.length}/${espn.report.tried}: ${espn.report.failed.slice(0, 3).map((f) => `${f.path} ${f.error}`).join('; ')}` : '';
  if (espnFail && !msg.includes('ESPN')) msg += espnFail;
  if (!FREE_KEYS.has(String(key))) msg = msg.split(String(key)).join('***'); // kunci premium tidak boleh ikut terbit di meta.json
  log(`Gagal mengambil data baru: ${msg}`);
  if (fs.existsSync(path.join(lastDir, 'meta.json'))) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.cpSync(lastDir, dataDir, { recursive: true });
    markStale(dataDir, msg, t);
    log('Memakai data terakhir yang berhasil (ditandai tertunda).');
    return { outDir, outcome: 'stale', matches: fs.readdirSync(path.join(dataDir, 'm')).length, version, error: msg };
  }
  // Belum pernah berhasil sama sekali: tampilkan data simulasi dengan label jelas.
  const demoApp = createApp({ dbPath: ':memory:', provider: 'demo', now, log: () => {} });
  try {
    const snap = await collect(demoApp, t, { maxBundles });
    writeData(dataDir, t, snap, { provider, fallbackActive: true, lastError: msg.slice(0, 500) });
  } finally { await demoApp.close(); }
  log('Belum ada data lama: memakai data simulasi (ditandai jelas di aplikasi).');
  return { outDir, outcome: 'demo', matches: fs.readdirSync(path.join(dataDir, 'm')).length, version, error: msg };
}

/* ------------------------------------------------------------------ CLI */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
  const result = await buildPages({
    outDir: arg('out', process.env.OUT_DIR || path.join(ROOT, 'dist')),
    stateDir: arg('state', process.env.STATE_DIR || path.join(ROOT, '.pages-state')),
    provider: (arg('provider', process.env.PROVIDER || 'auto')).toLowerCase(),
    key: process.env.THESPORTSDB_KEY || '3',
  });
  if (result.outcome !== 'fresh') console.log(`::warning title=JonBet::Build memakai ${result.outcome === 'stale' ? 'data lama (tertunda)' : 'data simulasi'}: ${result.error}`);
  console.log(`Selesai (${result.outcome}), ${result.matches} pertandingan, versi ${result.version}.`);
}

// Membangun situs statis untuk GitHub Pages ke folder keluaran (bawaan: dist/).
//
// GitHub Pages hanya menyajikan berkas statis, jadi skrip ini menjalankan layanan JonBet yang sama
// seperti server (sumber data, rating Elo, model, penjelasan) SEKALI, lalu menyimpan hasilnya sebagai JSON:
//   data/config.json, meta.json, matches.json, results.json, record.json, m/<id>.json (analisis per laga)
// Browser membaca berkas itu; model dan JonBet AI dijalankan ulang di browser untuk pertanyaan pengguna.
//
// Pemakaian:  node scripts/build-pages.mjs [--out dist] [--state .pages-state] [--provider thesportsdb|demo]
// Lingkungan: PROVIDER, THESPORTSDB_KEY, OUT_DIR, STATE_DIR
// Folder state (database SQLite rating Elo, cache HTTP, data terakhir) harus dipertahankan antar build
// (di GitHub Actions lewat actions/cache) agar model terus belajar dan permintaan ke sumber data hemat.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, CSP } from '../server/app.js';
import { ESPN_ORIGIN } from '../public/js/static/espn.js';
import { createTsdbProvider } from '../server/providers/thesportsdb.js';
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

/**
 * Pembungkus fetch untuk TheSportsDB: cache di disk (berkas kunci eventsday dipakai ulang antar build sesuai umur
 * tanggalnya), jeda antar permintaan nyata (kunci gratis dibatasi ±30 permintaan/menit), dan coba ulang singkat.
 */
export function makeFetch({ fetchImpl = globalThis.fetch, cacheFile = null, now = () => Date.now(), gapMs = 2200, retries = 2, retryDelayMs = 4000, sleep = sleepMs, stats = {} } = {}) {
  const cache = cacheFile ? readJson(cacheFile, {}) : {};
  let lastStart = 0;
  let queue = Promise.resolve();
  stats.network = 0; stats.cached = 0; stats.failed = 0; stats.ok = 0; stats.fallback = 0;

  const ttlOf = (url) => {
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
    if (ttl && hit && now() - hit.at < ttl) { stats.cached++; return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json' } }); }

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
        if (res.ok && ttl) cache[url] = { at: now(), body };
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

function writeData(dataDir, t, snap, { provider, stale = false, lastError = null, fallbackActive = false }) {
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
  writeJson(metaFile, { ...meta, stale: true, staleSince: meta.staleSince || meta.builtAt, lastError: String(lastError).slice(0, 200), checkedAt: new Date(t).toISOString() });
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
  provider = 'thesportsdb',
  key = '3',
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  log = (...a) => console.log(...a),
  gapMs,
  retryDelayMs,
  sleep,
  maxBundles = 1500,
  backfillDays = 14,
  backfillBudgetMs = 8 * 60_000,
} = {}) {
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
  const stats = {};
  const throttled = makeFetch({ fetchImpl, cacheFile: path.join(stateDir, 'http-cache.json'), now, gapMs: gapMs ?? (FREE_KEYS.has(String(key)) ? 2200 : 0), retryDelayMs, sleep, stats });
  const primary = createTsdbProvider({ key, fetchImpl: throttled, now, perMinute: 1e9, timeoutMs: 20_000 });
  const app = createApp({ dbPath: path.join(stateDir, 'jonbet.db'), provider: 'thesportsdb', fallbackDemo: false, primaryProvider: primary, now, log: (...a) => log('[sumber]', ...a) });

  let error = null;
  try {
    // Isi riwayat hasil (untuk rating Elo) dari yang terlama ke terbaru; dilanjutkan di build berikutnya bila waktu habis.
    const bfFile = path.join(stateDir, 'backfill.json');
    let next = readJson(bfFile, { next: backfillDays }).next;
    const deadline = Date.now() + backfillBudgetMs;
    while (next >= 1 && Date.now() < deadline) {
      const dayStart = t - next * DAY;
      try { await app.service.fetchList({ from: dayStart - 12 * HOUR, to: dayStart + 12 * HOUR, sports: null }); } catch (e) { log('Riwayat hari ke-', next, 'gagal:', e.message); break; }
      next--;
      writeJson(bfFile, { next });
    }
    const snap = await collect(app, t, { maxBundles });
    // Jika setiap permintaan nyata gagal, data yang terkumpul hanya dari cache lama: jangan tampilkan sebagai data baru.
    if (stats.network > 0 && stats.ok === 0) throw new Error(`Sumber data tidak merespons (${stats.failed} permintaan gagal)`);
    writeData(dataDir, t, snap, { provider: 'thesportsdb' });
    fs.rmSync(lastDir, { recursive: true, force: true });
    fs.cpSync(dataDir, lastDir, { recursive: true });
    log(`Data nyata: ${snap.matches.length} pertandingan, ${snap.health.results} hasil di riwayat. Permintaan: ${stats.network} jaringan, ${stats.cached} dari cache, ${stats.failed} gagal (${stats.fallback} dipulihkan dari cache lama).`);
  } catch (err) {
    error = err;
  } finally {
    throttled.save();
    await app.close(); // menutup SQLite dengan rapi (menggabungkan berkas WAL ke database)
  }
  if (!error) return { outDir, outcome: 'fresh', matches: fs.readdirSync(path.join(dataDir, 'm')).length, version };

  const msg = String(error?.message || error);
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
    writeData(dataDir, t, snap, { provider: 'thesportsdb', fallbackActive: true, lastError: msg.slice(0, 200) });
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
    provider: (arg('provider', process.env.PROVIDER || 'thesportsdb')).toLowerCase(),
    key: process.env.THESPORTSDB_KEY || '3',
  });
  if (result.outcome !== 'fresh') console.log(`::warning title=JonBet::Build memakai ${result.outcome === 'stale' ? 'data lama (tertunda)' : 'data simulasi'}: ${result.error}`);
  console.log(`Selesai (${result.outcome}), ${result.matches} pertandingan, versi ${result.version}.`);
}

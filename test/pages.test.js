// Tes versi GitHub Pages (tanpa server): komunitas lokal, penyaringan daftar di browser, dan skrip build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { createCommunity, pointsFor as serverPoints } from '../server/community.js';
import { SPORTS, SPORTS_BY_ID, publicSport } from '../server/sports.js';
import { teamKey } from '../server/util.js';
import { answer } from '../server/ai/explainer.js';
import { createLocalCommunity, pointsFor as localPoints, LocalError } from '../public/js/static/local-community.js';
import { queryMatches, QueryError } from '../public/js/static/query.js';
import { matchFile } from '../public/js/static/paths.js';
import { buildPages, makeFetch, SHARED_FILES } from '../scripts/build-pages.mjs';
import { mulberry as rng } from './rng.js';
import { fakeTsdb } from './fake-tsdb.js';

const T0 = Date.parse('2026-11-18T05:00:00Z');
const HOUR = 3_600_000;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `jb-${name}-`));
const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
};
const sportOf = (id) => SPORTS_BY_ID[id] || null;
const mkMatch = (over = {}) => ({
  id: 'demo:aa-1-0', sport: 'football', league: 'Liga', status: 'upcoming', kickoff: new Date(T0 + 5 * HOUR).toISOString(),
  home: { name: 'Alfa' }, away: { name: 'Beta' }, score: null, ...over,
});

/* ------------------------------------------------------------------ komunitas lokal */

test('komunitas lokal: profil, validasi nama, masuk/keluar, persistensi antar muat ulang', () => {
  const storage = fakeStorage();
  let lc = createLocalCommunity({ storage, now: () => T0, sportOf });
  assert.deepEqual(lc.me(), { user: null });
  for (const bad of ['ab', 'a'.repeat(21), 'nama spasi', 'nama-strip', '', 'admin', 'JonBet']) {
    assert.throws(() => lc.register(bad), (e) => e instanceof LocalError && e.status === 400, bad);
  }
  const r = lc.register('Budi_1');
  assert.equal(r.user.username, 'Budi_1');
  assert.throws(() => lc.register('budi_1'), (e) => e.status === 409, 'nama sama tanpa memandang huruf besar');
  lc.logout();
  assert.equal(lc.me().user, null);
  assert.throws(() => lc.login('tidak_ada'), (e) => e.status === 401);
  assert.equal(lc.login('BUDI_1').user.username, 'Budi_1');
  // muat ulang dari penyimpanan yang sama
  lc = createLocalCommunity({ storage, now: () => T0, sportOf });
  assert.equal(lc.me().user.username, 'Budi_1');
});

test('komunitas lokal: penyimpanan rusak / tidak bisa menulis tidak membuat aplikasi mati', () => {
  const bad = fakeStorage({ 'jonbet.local.v1': '{bukan json' });
  const lc = createLocalCommunity({ storage: bad, now: () => T0, sportOf });
  assert.equal(lc.me().user, null);
  lc.register('Budi_1');
  const wrongShape = fakeStorage({ 'jonbet.local.v1': JSON.stringify({ v: 1, users: 5, predictions: 'x' }) });
  assert.equal(createLocalCommunity({ storage: wrongShape, sportOf }).me().user, null);
  const readOnly = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
  const lc2 = createLocalCommunity({ storage: readOnly, now: () => T0, sportOf });
  lc2.register('Budi_1');
  assert.equal(lc2.save(mkMatch(), { pick: 'H', confidence: 3 }).updated, false, 'tetap bekerja di memori');
  assert.equal(createLocalCommunity({ storage: null, sportOf }).me().user, null);
});

test('komunitas lokal: validasi tebakan sama dengan server', () => {
  const lc = createLocalCommunity({ storage: fakeStorage(), now: () => T0, sportOf });
  assert.throws(() => lc.save(mkMatch(), { pick: 'H' }), (e) => e.status === 401, 'tanpa profil');
  lc.register('Budi_1');
  const bad = (match, input, status, code) => assert.throws(() => lc.save(match, input), (e) => e.status === status && e.code === code, `${JSON.stringify(input)} -> ${code}`);
  bad(mkMatch({ status: 'live' }), { pick: 'H' }, 409, 'closed');
  bad(mkMatch({ kickoff: new Date(T0 - 1).toISOString() }), { pick: 'H' }, 409, 'closed');
  bad(mkMatch(), { pick: 'X' }, 400, 'bad_pick');
  bad(mkMatch({ sport: 'basketball' }), { pick: 'D' }, 400, 'bad_pick');
  bad(mkMatch(), { pick: 'H', confidence: 0 }, 400, 'bad_confidence');
  bad(mkMatch(), { pick: 'H', confidence: 6 }, 400, 'bad_confidence');
  bad(mkMatch(), { pick: 'H', confidence: 2.5 }, 400, 'bad_confidence');
  bad(mkMatch(), { pick: 'H', scoreHome: 2 }, 400, 'bad_score');
  bad(mkMatch(), { pick: 'H', scoreHome: -1, scoreAway: 0 }, 400, 'bad_score');
  bad(mkMatch(), { pick: 'H', scoreHome: 100, scoreAway: 0 }, 400, 'bad_score');
  bad(mkMatch(), { pick: 'H', scoreHome: 1, scoreAway: 1 }, 400, 'score_mismatch');
  bad(mkMatch(), { pick: 'A', scoreHome: 2, scoreAway: 1 }, 400, 'score_mismatch');
  bad(mkMatch(), { pick: 'D', scoreHome: 2, scoreAway: 1 }, 400, 'score_mismatch');
  bad(mkMatch({ sport: 'unknown' }), { pick: 'H' }, 400, 'bad_sport');
  assert.equal(lc.save(mkMatch({ sport: 'basketball' }), { pick: 'H', scoreHome: 120, scoreAway: 100 }).updated, false, 'basket boleh skor sampai 400');
  const a = lc.save(mkMatch(), { pick: 'H', confidence: 4, note: '  <b>halo</b>\u0000 ' });
  const b = lc.save(mkMatch(), { pick: 'A', confidence: 2 });
  assert.equal(a.id, b.id);
  assert.equal(b.updated, true, 'tebakan kedua untuk laga yang sama memperbarui, bukan menggandakan');
  const fm = lc.forMatch('demo:aa-1-0');
  assert.equal(fm.total, 1);
  assert.deepEqual(fm.counts, { H: 0, D: 0, A: 1 });
  assert.equal(fm.items[0].mine, true);
  assert.equal(lc.save(mkMatch({ id: 'demo:aa-2-0' }), { pick: 'H', note: 'x'.repeat(400) }).updated, false);
  assert.equal(lc.forMatch('demo:aa-2-0').items[0].note.length, 280);
});

test('komunitas lokal: hapus, kunci setelah kickoff, suka antar profil', () => {
  let clock = T0;
  const lc = createLocalCommunity({ storage: fakeStorage(), now: () => clock, sportOf });
  lc.register('Budi_1');
  const { id } = lc.save(mkMatch(), { pick: 'H', confidence: 3 });
  assert.throws(() => lc.toggleLike(id), (e) => e.code === 'self_like');
  lc.logout();
  lc.register('Sari_2');
  assert.throws(() => lc.remove(id), (e) => e.status === 404, 'milik orang lain');
  assert.deepEqual(lc.toggleLike(id), { liked: true, likes: 1 });
  assert.deepEqual(lc.toggleLike(id), { liked: false, likes: 0 });
  lc.toggleLike(id);
  assert.equal(lc.feed({ sort: 'top' })[0].likes, 1);
  assert.equal(lc.feed({ sort: 'top' })[0].liked, true);
  lc.logout();
  lc.login('Budi_1');
  clock = T0 + 6 * HOUR; // lewat kickoff
  assert.throws(() => lc.remove(id), (e) => e.status === 409 && e.code === 'locked');
  clock = T0;
  assert.equal(lc.remove(id), true);
  assert.equal(lc.feed().length, 0);
  assert.equal(lc.toggleLike === undefined, false);
});

test('komunitas lokal: penilaian setara server (fuzz 600 kasus: status dan poin)', () => {
  const db = openDb(':memory:');
  const auth = createAuth(db);
  const user = auth.register('Penguji_1', 'kata-sandi-1').user;
  const rand = rng(20261118);
  let clock = T0;
  const server = createCommunity(db, { now: () => clock });
  const lc = createLocalCommunity({ storage: fakeStorage(), now: () => clock, sportOf });
  lc.register('Penguji_1');
  for (let i = 0; i < 600; i++) {
    const cfg = SPORTS[Math.floor(rand() * SPORTS.length)];
    const id = `demo:fz-${i}-0`;
    const match = mkMatch({ id, sport: cfg.id });
    const pick = ['H', 'A', ...(cfg.drawable ? ['D'] : [])][Math.floor(rand() * (cfg.drawable ? 3 : 2))];
    const confidence = 1 + Math.floor(rand() * 5);
    let sh = null; let sa = null;
    if (rand() < 0.5) {
      const hi = 1 + Math.floor(rand() * 4); const lo = Math.floor(rand() * hi);
      [sh, sa] = pick === 'H' ? [hi, lo] : pick === 'A' ? [lo, hi] : [lo, lo];
    }
    const input = { pick, confidence, scoreHome: sh, scoreAway: sa, note: `n${i}` };
    server.save(user, match, input);
    lc.save(match, input);
    const kind = rand();
    const hs = Math.floor(rand() * 5); const as = Math.floor(rand() * 5);
    const finished = { ...match, status: kind < 0.9 ? 'finished' : 'cancelled', score: kind < 0.9 ? { home: hs, away: as } : null };
    server.settle(finished);
    lc.settle((mid) => (mid === id ? (finished.status === 'finished' ? { status: 'finished', score: finished.score } : { status: 'cancelled' }) : null));
  }
  const sp = server.profile('Penguji_1', null);
  const lp = lc.profile('Penguji_1');
  assert.equal(lp.points, sp.points, 'total poin');
  assert.equal(lp.wins, sp.wins);
  assert.equal(lp.settled, sp.settled);
  assert.equal(lp.accuracy, sp.accuracy);
  assert.equal(lp.pending, 0);
  const sf = Object.fromEntries(server.feed({ limit: 50 }).map((p) => [p.match.id, [p.status, p.points]]));
  for (const p of lc.feed({ limit: 50 })) assert.deepEqual([p.status, p.points], sf[p.match.id], p.match.id);
  for (const conf of [1, 2, 3, 4, 5]) for (const won of [true, false]) for (const exactScore of [true, false]) {
    assert.equal(localPoints({ won, confidence: conf, exactScore }), serverPoints({ won, confidence: conf, exactScore }));
  }
});

test('komunitas lokal: tebakan menggantung dibatalkan setelah 14 hari; papan peringkat dan profil', () => {
  let clock = T0;
  const lc = createLocalCommunity({ storage: fakeStorage(), now: () => clock, sportOf });
  lc.register('Budi_1');
  lc.save(mkMatch({ id: 'demo:old-1-0' }), { pick: 'H', confidence: 3 });
  lc.save(mkMatch({ id: 'demo:win-1-0' }), { pick: 'H', confidence: 5, scoreHome: 2, scoreAway: 0 });
  lc.logout();
  lc.register('Sari_2');
  lc.save(mkMatch({ id: 'demo:win-1-0' }), { pick: 'A', confidence: 1 });
  clock = T0 + 6 * HOUR;
  assert.equal(lc.settle((id) => (id === 'demo:win-1-0' ? { status: 'finished', score: { home: 2, away: 0 } } : null)), 2);
  assert.equal(lc.hasPending(), true, 'demo:old-1-0 masih menunggu');
  assert.equal(lc.leaderboard({ period: 'week' }).length, 2, 'baru dinilai: masuk peringkat mingguan');
  clock = T0 + 15 * 24 * HOUR;
  assert.equal(lc.settle(() => null), 1);
  assert.equal(lc.hasPending(), false);
  const lb = lc.leaderboard({ period: 'all' });
  assert.deepEqual(lb.map((r) => [r.rank, r.username, r.points]), [[1, 'Budi_1', 10 + 10 + 10], [2, 'Sari_2', -1]]);
  assert.equal(lc.leaderboard({ period: 'week' }).length, 0, 'lewat seminggu keluar dari peringkat mingguan');
  const p = lc.profile('Budi_1');
  assert.equal(p.streak, 1);
  assert.equal(p.recent.length, 2);
  assert.throws(() => lc.profile('tidak_ada'), (e) => e.status === 404);
});

/* ------------------------------------------------------------------ penyaringan daftar */

test('penyaringan di browser setara GET /api/matches di server (puluhan kombinasi)', async () => {
  const app = createApp({ dbPath: ':memory:', provider: 'demo', now: () => T0, log: () => {} });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const from = T0 - 48 * HOUR; const to = T0 + 5 * 24 * HOUR;
    const all = await app.service.list({ from, to, sports: null, status: 'all', limit: 100000 });
    const snap = { builtAt: new Date(T0).toISOString(), meta: all.meta, matches: all.matches };
    const sportIds = SPORTS.map((s) => s.id);
    const cases = [
      '', 'status=live', 'status=upcoming', 'status=finished', 'sport=football', 'sport=tennis&status=upcoming', 'q=komodo', 'q=GARUDA', 'q=zzzxx',
      `from=${T0}&to=${T0 + 24 * HOUR}&status=upcoming&limit=80`, `from=${T0 - 24 * HOUR}&to=${T0}&status=finished`, 'limit=3', 'limit=1&status=live',
      `from=${new Date(T0).toISOString()}&to=${new Date(T0 + 6 * HOUR).toISOString()}`, 'sport=basketball&status=finished&q=a',
    ];
    for (const qs of cases) {
      const res = await fetch(`http://127.0.0.1:${port}/api/matches?${qs}`);
      const srv = await res.json();
      const sp = new URLSearchParams(qs);
      const mine = queryMatches(snap, sp, { now: T0, teamKey, sportIds });
      assert.deepEqual(mine.matches.map((m) => m.id), srv.matches.map((m) => m.id), `daftar: ${qs}`);
      assert.deepEqual(mine.counts, srv.counts, `counts: ${qs}`);
      assert.equal(mine.meta.total, srv.meta.total, `total: ${qs}`);
    }
    // galat: pesan dan status sama
    for (const qs of ['status=ngawur', 'sport=catur', 'limit=0', 'limit=501', 'limit=abc', 'from=kemarin', `from=${T0}&to=${T0 - 1}`, `from=${T0}&to=${T0 + 10 * 24 * HOUR}`]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/matches?${qs}`);
      const srv = await res.json();
      assert.equal(res.status, 400, qs);
      assert.throws(() => queryMatches(snap, new URLSearchParams(qs), { now: T0, teamKey, sportIds }),
        (e) => e instanceof QueryError && e.status === 400 && e.message === srv.error.message, qs);
    }
  } finally { await app.close(); }
});

test('nama berkas pertandingan: aman, deterministik, tanpa bentrok', () => {
  assert.equal(matchFile('tsdb:2217385'), 'm/tsdb_2217385.json');
  assert.equal(matchFile('demo:btk-249278-0'), 'm/demo_btk-249278-0.json');
  for (const bad of ['../etc/passwd', 'tsdb:../x', 'x:1', '', 'tsdb:', 'tsdb:a/b', 'tsdb:' + 'a'.repeat(49), 'demo:%2e%2e', null, undefined]) assert.equal(matchFile(bad), null, String(bad));
  const ids = ['tsdb:1', 'tsdb:12', 'demo:a-1', 'demo:a_1', 'tsdb:1-2', 'tsdb:1_2'];
  assert.equal(new Set(ids.map(matchFile)).size, ids.length);
});

/* ------------------------------------------------------------------ pembungkus fetch */

test('makeFetch: jeda antar permintaan nyata, cache menurut umur tanggal, coba ulang, cadangan saat gagal', async () => {
  const dir = tmp('fetch');
  const cacheFile = path.join(dir, 'c.json');
  let clock = T0;
  const sleeps = [];
  let calls = 0;
  let mode = 'ok';
  const fetchImpl = async (url) => {
    calls++;
    if (mode === 'err') throw new Error('jaringan putus');
    if (mode === '500') return new Response('x', { status: 500 });
    if (mode === '429') return new Response('x', { status: 429 });
    return new Response(JSON.stringify({ events: [{ url }] }), { status: 200 });
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  const mk = () => makeFetch({ fetchImpl, cacheFile, now: () => clock, gapMs: 50, retryDelayMs: 10, sleep, stats: {} });
  const f = mk();
  const today = '2026-11-18';
  const u = (d, s = 'Soccer') => `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${d}&s=${s}`;
  assert.equal((await f(u(today))).status, 200);
  const before = calls;
  await f(u(today));
  assert.equal(calls, before, 'hari ini: cache 5 menit');
  clock += 6 * 60_000;
  await f(u(today));
  assert.equal(calls, before + 1, 'hari ini: lewat 5 menit diambil lagi');
  await f(u('2026-11-10'));
  clock += 11 * HOUR;
  await f(u('2026-11-10'));
  assert.equal(calls, before + 2, 'tanggal lama: cache 12 jam');
  clock += 2 * HOUR;
  await f(u('2026-11-10'));
  assert.equal(calls, before + 3);
  await f('https://www.thesportsdb.com/api/v2/json/livescore/all');
  await f('https://www.thesportsdb.com/api/v2/json/livescore/all');
  assert.equal(calls, before + 5, 'livescore tidak pernah di-cache');
  assert.ok(sleeps.some((ms) => ms > 0 && ms <= 50), 'jeda antar permintaan nyata dipakai');
  f.save();
  // cache bertahan antar proses
  const f2 = mk();
  const c0 = calls;
  await f2(u('2026-11-10'));
  assert.equal(calls, c0, 'cache dimuat dari disk');
  // gagal: coba ulang lalu pakai cache lama; tanpa cache -> galat
  mode = '500';
  clock += 13 * HOUR;
  const old = await f2(u('2026-11-10'));
  assert.equal(old.status, 200, 'cadangan dari cache lama saat sumber gagal');
  await assert.rejects(() => f2(u('2026-11-11')), /HTTP 500/);
  mode = '429';
  await assert.rejects(() => f2(u('2026-11-12')), /HTTP 429/);
  mode = 'err';
  await assert.rejects(() => f2(u('2026-11-13')), /jaringan putus/);
  mode = 'ok';
  assert.equal((await f2(u('2026-11-13'))).status, 200, 'pulih setelah gangguan');
});

/* ------------------------------------------------------------------ build */

const quiet = () => {};
const readJ = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));

test('build GitHub Pages (demo): situs lengkap, relatif, CSP lewat meta, setiap daftar punya bundel', async () => {
  const out = tmp('out'); const state = tmp('state');
  const r = await buildPages({ outDir: path.join(out, 'dist'), stateDir: state, provider: 'demo', now: () => T0, log: quiet });
  const dist = r.outDir;
  assert.equal(r.outcome, 'fresh');
  assert.ok(r.matches > 100, `hanya ${r.matches} laga`);
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', '.nojekyll', 'js/main.js', 'js/mode.js', 'js/shared/util.js', 'js/shared/ai/explainer.js', 'data/config.json', 'data/meta.json', 'data/matches.json', 'data/results.json', 'data/record.json']) {
    assert.ok(fs.existsSync(path.join(dist, f)), `berkas hilang: ${f}`);
  }
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /<meta name="jonbet-mode" content="static" \/>/);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.ok(csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && !csp.includes('frame-ancestors') && !/unsafe-inline|unsafe-eval/.test(csp), csp);
  // satu-satunya asal luar yang boleh dihubungi browser adalah sumber skor langsung, dan hanya lewat connect-src
  const directives = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
  assert.deepEqual(directives['connect-src'], ["'self'", 'https://site.api.espn.com', 'https://api.anthropic.com']);
  for (const [k, v] of Object.entries(directives)) if (k !== 'connect-src' && k !== 'img-src') assert.ok(!v.some((x) => /^https?:/.test(x)), `${k} tidak boleh memuat asal luar`);
  assert.ok(!/(?:href|src)="\//.test(html), 'tidak boleh ada rujukan absolut');
  const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
  assert.match(sw, /const VERSION = 'p[0-9a-f]{10}';/);

  const cfg = readJ(dist, 'data/config.json');
  assert.equal(cfg.sports.length, 12);
  assert.deepEqual(cfg.sports[0], publicSport(SPORTS[0]));
  assert.equal(cfg.demo, true);
  assert.equal(cfg.fallbackActive, false);
  const meta = readJ(dist, 'data/meta.json');
  assert.equal(meta.builtAt, new Date(T0).toISOString());
  assert.equal(meta.stale, false);
  const snap = readJ(dist, 'data/matches.json');
  assert.equal(snap.matches.length, r.matches);
  const files = new Set(fs.readdirSync(path.join(dist, 'data/m')));
  for (const m of snap.matches) {
    const f = matchFile(m.id);
    assert.ok(files.has(path.basename(f)), `bundel hilang untuk ${m.id}`);
    assert.ok(m.forecast && Number.isFinite(m.forecast.home), 'prakiraan ada di daftar');
  }
  assert.equal(files.size, snap.matches.length, 'tidak ada bundel yatim');
  // isi bundel utuh dan bisa dipakai AI di browser (salinan modul bersama di dist)
  const sample = snap.matches.find((m) => m.status === 'upcoming' && m.sport === 'football');
  const b = readJ(dist, 'data', matchFile(sample.id));
  for (const k of ['match', 'analysis', 'form', 'h2h', 'summary', 'ratings', 'meta']) assert.ok(b[k], `bundel tanpa ${k}`);
  assert.ok(!JSON.stringify(b).includes('NaN') && !JSON.stringify(b).includes('Infinity'));
  // model di browser (salinan di dist) menghasilkan angka yang sama persis dengan model server
  const distModel = await import(pathToFileURL(path.join(dist, 'js/shared/model/model.js')).href);
  const { analyze: serverAnalyze } = await import('../server/model/model.js');
  const liveCopy = { ...b.match, status: 'live', score: { home: 1, away: 0 }, minute: 55, progress: 55 / 90 };
  assert.deepEqual(distModel.analyze({ sport: b.match.sport, match: liveCopy, homeStats: b.ratings.home, awayStats: b.ratings.away }),
    serverAnalyze({ sport: b.match.sport, match: liveCopy, homeStats: b.ratings.home, awayStats: b.ratings.away }));
  // bundel di berkas dibulatkan 5 desimal; hitung ulang dari rating di bundel harus sama sampai pembulatan itu
  const close = (x, y, where = '') => {
    if (typeof x === 'number' && typeof y === 'number') return assert.ok(Math.abs(x - y) <= 2e-5, `${where}: ${x} vs ${y}`);
    if (x && y && typeof x === 'object') { assert.deepEqual(Object.keys(x).sort(), Object.keys(y).sort(), where); for (const k of Object.keys(x)) close(x[k], y[k], `${where}.${k}`); return undefined; }
    return assert.deepEqual(x, y, where);
  };
  close(JSON.parse(JSON.stringify(distModel.analyze({ sport: b.match.sport, match: b.match, homeStats: b.ratings.home, awayStats: b.ratings.away }))), b.analysis, 'analisis');
  // semua impor di modul bersama bisa ditemukan
  for (const f of SHARED_FILES) {
    const src = fs.readFileSync(path.join(dist, 'js/shared', f), 'utf8');
    for (const im of src.matchAll(/from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(dist, 'js/shared', f)), im[1])), `${f} mengimpor ${im[1]} yang tidak ada di dist`);
    }
  }
  const distExplainer = await import(pathToFileURL(path.join(dist, 'js/shared/ai/explainer.js')).href);
  const a1 = distExplainer.answer({ question: 'Siapa yang menang?', match: b.match, analysis: b.analysis, form: b.form, h2h: b.h2h, sport: SPORTS_BY_ID[b.match.sport] });
  const a2 = answer({ question: 'Siapa yang menang?', match: b.match, analysis: b.analysis, form: b.form, h2h: b.h2h, sport: SPORTS_BY_ID[b.match.sport] });
  assert.deepEqual(a1, a2);
  assert.match(a1.reply, /%/);
  const bet = distExplainer.answer({ question: 'taruh berapa ya supaya cuan?', match: b.match, analysis: b.analysis, form: b.form, h2h: b.h2h, sport: SPORTS_BY_ID[b.match.sport] });
  assert.match(bet.reply, /taruhan|bertaruh/i, 'penolakan taruhan juga berlaku di browser');
  // ukuran wajar
  const total = fs.readdirSync(path.join(dist, 'data/m')).reduce((s, f) => s + fs.statSync(path.join(dist, 'data/m', f)).size, 0);
  assert.ok(total / r.matches < 12_000, `bundel terlalu besar: ${Math.round(total / r.matches)} B/laga`);
  // versi SW stabil bila kode sama, berubah bila kode berubah
  const out2 = tmp('out2');
  const r2 = await buildPages({ outDir: path.join(out2, 'dist'), stateDir: tmp('state2'), provider: 'demo', now: () => T0 + 600_000, log: quiet });
  assert.equal(r2.version, r.version, 'versi SW tidak berubah antar build bila kode sama');
});

test('build menolak folder keluaran berbahaya', async () => {
  for (const bad of ['/', '/tmp', path.resolve('.')]) {
    await assert.rejects(() => buildPages({ outDir: bad, stateDir: tmp('s'), provider: 'demo', log: quiet }), /tidak aman/, bad);
  }
});

test('build data nyata (TheSportsDB palsu): data, riwayat hasil, rating, cache, dan database tertutup rapi', async () => {
  const out = tmp('real'); const state = tmp('realstate');
  const net = fakeTsdb({ now: T0 });
  const logs = [];
  const opts = { outDir: path.join(out, 'dist'), stateDir: state, provider: 'thesportsdb', now: () => T0, fetchImpl: net.impl, gapMs: 0, retryDelayMs: 0, log: (...a) => logs.push(a.join(' ')) };
  const r = await buildPages(opts);
  assert.equal(r.outcome, 'fresh');
  const dist = r.outDir;
  const cfg = readJ(dist, 'data/config.json');
  assert.equal(cfg.demo, false);
  assert.equal(cfg.provider, 'thesportsdb');
  const snap = readJ(dist, 'data/matches.json');
  assert.ok(snap.matches.length > 100);
  assert.ok(snap.matches.every((m) => m.id.startsWith('tsdb:')));
  const by = (s) => snap.matches.filter((m) => m.status === s).length;
  assert.ok(by('finished') > 20 && by('upcoming') > 20 && by('live') >= 1, `status: ${by('finished')}/${by('upcoming')}/${by('live')}`);
  const meta = readJ(dist, 'data/meta.json');
  assert.ok(meta.results > 100, 'riwayat hasil terisi lewat pengisian awal');
  // rating belajar: tim yang sudah sering main punya jumlah laga > 0 dan form terisi
  const up = snap.matches.find((m) => m.status === 'upcoming');
  const b = readJ(dist, 'data', matchFile(up.id));
  assert.ok(b.ratings.home.games > 0 && b.form.home.n > 0, 'rating dan form berasal dari riwayat');
  assert.equal(b.meta.demo, false);
  // hasil 14 hari terakhir dikirim untuk penilaian tebakan di browser
  const res = readJ(dist, 'data/results.json');
  assert.ok(Object.keys(res.finished).length > 50);
  assert.ok(Object.values(res.finished).every((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isInteger)));
  const rec = readJ(dist, 'data/record.json');
  assert.equal(rec.demo, false);
  assert.ok(rec.all.backtest.n > 20, 'rekam jejak uji-mundur terisi');
  assert.deepEqual(Object.keys(rec.sports).sort(), SPORTS.map((s) => s.id).sort());
  // state: database tertutup rapi (tidak ada berkas WAL), cache HTTP dan data terakhir tersimpan
  const left = fs.readdirSync(state).sort();
  assert.ok(left.includes('jonbet.db') && left.includes('http-cache.json') && left.includes('last-data') && left.includes('backfill.json'), left.join(','));
  assert.ok(!left.some((f) => f.endsWith('-wal') || f.endsWith('-shm')), `sisa WAL: ${left.join(',')}`);
  assert.equal(readJ(state, 'backfill.json').next, 0, 'pengisian riwayat selesai');

  // build kedua (10 menit kemudian): jauh lebih sedikit permintaan berkat cache; rating tidak berlipat ganda
  const calls1 = net.log.length;
  const games1 = b.ratings.home.games;
  const out2 = tmp('real2');
  const r2 = await buildPages({ ...opts, outDir: path.join(out2, 'dist'), now: () => T0 + 600_000 });
  assert.equal(r2.outcome, 'fresh');
  const calls2 = net.log.length - calls1;
  assert.ok(calls2 < calls1 / 3, `build kedua harus hemat: ${calls2} vs ${calls1}`);
  const snap2 = readJ(r2.outDir, 'data/matches.json');
  const b2 = readJ(r2.outDir, 'data', matchFile(up.id));
  assert.equal(b2.ratings.home.games, games1, 'hasil yang sama tidak dihitung dua kali oleh Elo');
  assert.ok(snap2.matches.length > 0);
});

test('build data nyata: gangguan sumber -> data lama ditandai tertunda; tanpa data lama -> demo berlabel', async () => {
  const out = tmp('fail'); const state = tmp('failstate');
  const base = { stateDir: state, provider: 'thesportsdb', gapMs: 0, retryDelayMs: 0, log: quiet };
  // 1) belum pernah berhasil + sumber mati -> demo berlabel, state tidak tercemar
  const dead = fakeTsdb({ now: T0, failAll: true });
  const r1 = await buildPages({ ...base, outDir: path.join(out, 'a'), now: () => T0, fetchImpl: dead.impl });
  assert.equal(r1.outcome, 'demo');
  assert.match(r1.error, /tidak bisa dihubungi/);
  const c1 = readJ(r1.outDir, 'data/config.json');
  assert.equal(c1.demo, true);
  assert.equal(c1.fallbackActive, true);
  assert.ok(!fs.existsSync(path.join(state, 'last-data')), 'data demo tidak disimpan sebagai data terakhir');
  assert.ok(r1.matches > 100);
  // 2) sukses
  const ok = fakeTsdb({ now: T0 });
  const r2 = await buildPages({ ...base, outDir: path.join(out, 'b'), now: () => T0 + 600_000, fetchImpl: ok.impl });
  assert.equal(r2.outcome, 'fresh');
  const good = readJ(r2.outDir, 'data/matches.json');
  // 3) sumber mati lagi -> data terakhir ditandai tertunda
  const r3 = await buildPages({ ...base, outDir: path.join(out, 'c'), now: () => T0 + 1_800_000, fetchImpl: dead.impl });
  assert.equal(r3.outcome, 'stale', 'cache lama dari permintaan gagal tidak boleh tampil sebagai data baru');
  const m3 = readJ(r3.outDir, 'data/matches.json');
  assert.equal(m3.meta.stale, true);
  assert.deepEqual(m3.matches.map((m) => m.id), good.matches.map((m) => m.id));
  assert.equal(readJ(r3.outDir, 'data/meta.json').builtAt, new Date(T0 + 600_000).toISOString(), 'jam data = build sukses terakhir');
  // 4) sumber pulih -> segar lagi dan tanda tertunda hilang
  const r4 = await buildPages({ ...base, outDir: path.join(out, 'd'), now: () => T0 + 2_400_000, fetchImpl: ok.impl });
  assert.equal(r4.outcome, 'fresh');
  assert.equal(readJ(r4.outDir, 'data/meta.json').stale, false);
  assert.equal(readJ(r4.outDir, 'data/matches.json').meta.stale, false);
});

test('build data nyata: sumber mati penuh setelah sukses -> stale', async () => {
  const out = tmp('stale'); const state = tmp('stalestate');
  const base = { stateDir: state, provider: 'thesportsdb', gapMs: 0, retryDelayMs: 0, log: quiet };
  const ok = fakeTsdb({ now: T0 });
  const r1 = await buildPages({ ...base, outDir: path.join(out, 'a'), now: () => T0, fetchImpl: ok.impl });
  assert.equal(r1.outcome, 'fresh');
  const first = readJ(r1.outDir, 'data/matches.json');
  // 2 jam kemudian semua cache kedaluwarsa dan sumber mati
  const dead = fakeTsdb({ now: T0, failAll: true });
  const r2 = await buildPages({ ...base, outDir: path.join(out, 'b'), now: () => T0 + 30 * 24 * HOUR, fetchImpl: dead.impl });
  assert.equal(r2.outcome, 'stale');
  const meta = readJ(r2.outDir, 'data/meta.json');
  assert.equal(meta.stale, true);
  assert.equal(meta.builtAt, new Date(T0).toISOString(), 'jam data tetap jam data lama');
  assert.ok(meta.lastError);
  const m2 = readJ(r2.outDir, 'data/matches.json');
  assert.equal(m2.meta.stale, true);
  assert.deepEqual(m2.matches.map((m) => m.id), first.matches.map((m) => m.id), 'isi data lama utuh');
  assert.equal(fs.readdirSync(path.join(r2.outDir, 'data/m')).length, first.matches.length);
});

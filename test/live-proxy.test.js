// Tes proxy skor langsung (Cloudflare Worker) dan sumber proxy di browser. Penyedia dipalsukan; tidak ada jaringan.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createHandler, normalizeApiFootball, normalizeTsdb } from '../worker/live-proxy.js';
import { cleanProxyUrl, overlayFromProxy, parseProxy } from '../public/js/static/proxy.js';
import { createLiveFeed } from '../public/js/static/live.js';
import { analyze, pickOf } from '../server/model/model.js';
import { explain } from '../server/ai/explainer.js';
import { SPORTS_BY_ID, publicSport } from '../server/sports.js';
import { board, espnEvent, fakeEspn } from './fake-espn.js';
import { ESPN_ORIGIN } from '../public/js/static/espn.js';

const T0 = Date.parse('2026-11-18T14:00:00Z');
const MIN = 60_000;
const KEY = 'RAHASIA-KUNCI-123';
const ORIGIN = 'https://akmal.github.io';
const PROXY = 'https://jonbet-live.akmal.workers.dev/live';

const afRow = (id, short, elapsed, home, away, hs, as, extra = null) => ({
  fixture: { id, date: new Date(T0 - 30 * MIN).toISOString(), status: { short, elapsed, extra } },
  league: { name: 'Premier League' }, teams: { home: { name: home }, away: { name: away } }, goals: { home: hs, away: as },
});
const AF = {
  errors: [],
  response: [
    afRow(1, '2H', 67, 'Manchester City', 'Arsenal', 2, 1),
    afRow(2, 'HT', 45, 'Chelsea', 'Liverpool', 0, 0),
    afRow(3, 'NS', null, 'Everton', 'Fulham', null, null),
    afRow(4, 'FT', 90, 'Brighton', 'Brentford', 3, 3),
    afRow(5, '1H', 45, 'Aston Villa', 'Wolves', 1, 0, 3),
    afRow(6, 'PST', null, 'Leeds', 'Burnley', null, null),
  ],
};
const TS = {
  livescore: [
    { idEvent: '10', strSport: 'Basketball', strLeague: 'NBA', strHomeTeam: 'Los Angeles Lakers', strAwayTeam: 'Boston Celtics', intHomeScore: '54', intAwayScore: '51', strStatus: 'Q2', strProgress: '7', strTimestamp: '2026-11-18T13:30:00' },
    { idEvent: '11', strSport: 'Soccer', strLeague: 'La Liga', strHomeTeam: 'Real Madrid', strAwayTeam: 'Sevilla', intHomeScore: '1', intAwayScore: '0', strStatus: '2H', strProgress: "72'" },
    { idEvent: '12', strSport: 'Soccer', strLeague: 'La Liga', strHomeTeam: 'Getafe', strAwayTeam: 'Betis', intHomeScore: null, intAwayScore: null, strStatus: 'NS' },
    { idEvent: '13', strSport: 'Cricket', strLeague: 'IPL', strHomeTeam: 'A', strAwayTeam: 'B', intHomeScore: '1', intAwayScore: '0', strStatus: 'Live' },
    { idEvent: '14', strSport: 'Soccer', strLeague: 'Serie A', strHomeTeam: 'Inter', strAwayTeam: 'Milan', intHomeScore: '2', intAwayScore: '2', strStatus: 'FT' },
  ],
};

/** Penyedia palsu + cache palsu; mencatat panggilan. */
function rig({ body = AF, status = 200, now = () => T0, env = {} } = {}) {
  const calls = [];
  const store = new Map();
  const cache = { match: async (k) => store.get(k)?.clone(), put: async (k, r) => { store.set(k, r); } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (typeof body === 'function') return body(calls.length);
    return new Response(JSON.stringify(body), { status });
  };
  const handle = createHandler({ fetchImpl, now, cache });
  const e = { LIVE_PROVIDER: 'apifootball', LIVE_API_KEY: KEY, ALLOWED_ORIGINS: ORIGIN, ...env };
  const get = (path = '/live', headers = { Origin: ORIGIN }, method = 'GET') => handle(new Request(`https://jonbet-live.akmal.workers.dev${path}`, { method, headers }), e);
  return { calls, get, handle, store };
}

/* ------------------------------------------------------------------ normalisasi penyedia */

test('API-Football: hanya laga berjalan/selesai, menit dan babak benar', () => {
  const ev = normalizeApiFootball(AF);
  assert.deepEqual(ev.map((e) => e.id), ['af:1', 'af:2', 'af:4', 'af:5']);
  const [a, ht, ft, et] = ev;
  assert.deepEqual([a.state, a.minute, a.period, a.hs, a.as, a.sport], ['in', 67, 'Babak 2', 2, 1, 'football']);
  assert.deepEqual([ht.state, ht.code, ht.period], ['in', 'HT', 'Turun minum']);
  assert.deepEqual([ft.state, ft.period, ft.minute], ['post', 'Selesai', null]);
  assert.equal(et.minute, 48, 'menit tambahan dijumlahkan');
  assert.throws(() => normalizeApiFootball({ errors: { token: 'Error/Missing application key' }, response: [] }), /Missing application key/);
  assert.throws(() => normalizeApiFootball({ errors: { rateLimit: 'Too many requests' } }), /Too many/);
  assert.deepEqual(normalizeApiFootball({ errors: [], response: [] }), []);
  assert.deepEqual(normalizeApiFootball(null), []);
});

test('TheSportsDB: cabang dipetakan, yang belum mulai atau tak dikenal dibuang', () => {
  const ev = normalizeTsdb(TS);
  assert.deepEqual(ev.map((e) => e.id), ['ts:10', 'ts:11', 'ts:14']);
  const [nba, liga, inter] = ev;
  assert.deepEqual([nba.sport, nba.hs, nba.as, nba.period, nba.minute, nba.kickoff], ['basketball', 54, 51, 'Q2', null, Date.parse('2026-11-18T13:30:00Z')]);
  assert.deepEqual([liga.sport, liga.minute, liga.period, liga.kickoff], ['football', 72, 'Babak 2', null]);
  assert.deepEqual([inter.state, inter.period], ['post', 'Selesai']);
  assert.throws(() => normalizeTsdb({ Message: 'Invalid API key' }), /Invalid API key/);
  assert.deepEqual(normalizeTsdb({}), []);
});

/* ------------------------------------------------------------------ worker */

test('worker: respons ternormalisasi, kunci dikirim ke penyedia dan tidak pernah ke klien', async () => {
  const { get, calls } = rig();
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('vary'), 'Origin');
  const text = await res.text();
  assert.ok(!text.includes(KEY));
  const j = JSON.parse(text);
  assert.equal(j.ok, true);
  assert.equal(j.provider, 'apifootball');
  assert.equal(j.events.length, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://v3.football.api-sports.io/fixtures?live=all');
  assert.equal(calls[0].init.headers['x-apisports-key'], KEY);
});

test('worker: TheSportsDB memakai header X-API-KEY', async () => {
  const { get, calls } = rig({ body: TS, env: { LIVE_PROVIDER: 'thesportsdb' } });
  const j = await (await get()).json();
  assert.equal(j.events.length, 3);
  assert.equal(calls[0].url, 'https://www.thesportsdb.com/api/v2/json/livescore/all');
  assert.equal(calls[0].init.headers['X-API-KEY'], KEY);
});

test('worker: cache bersama membatasi pemakaian kuota (satu panggilan per jendela)', async () => {
  let t = T0;
  const { get, calls } = rig({ now: () => t, env: { CACHE_SECONDS: '15' } });
  for (let i = 0; i < 20; i++) assert.equal((await get()).status, 200);
  assert.equal(calls.length, 1, '20 pengunjung = 1 panggilan ke penyedia');
  t += 16_000;
  await get();
  assert.equal(calls.length, 2, 'setelah kedaluwarsa ditanya lagi');
  // batas CACHE_SECONDS dijepit 5..120
  const low = rig({ now: () => t, env: { CACHE_SECONDS: '0' } });
  await low.get(); t += 3000; await low.get();
  assert.equal(low.calls.length, 1, 'minimal 5 detik');
});

test('worker: CORS hanya untuk asal yang diizinkan; preflight; metode lain ditolak', async () => {
  const { get, calls } = rig({ env: { ALLOWED_ORIGINS: `${ORIGIN}/, https://lain.example` } });
  assert.equal((await get('/live', { Origin: 'https://jahat.example' })).status, 403);
  assert.equal((await get('/live', { Origin: 'null' })).status, 403);
  assert.equal(calls.length, 0, 'asal terlarang tidak menyentuh kuota');
  assert.equal((await get('/live', { Origin: 'https://lain.example' })).status, 200);
  const pre = await get('/live', { Origin: ORIGIN }, 'OPTIONS');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await get('/live', { Origin: ORIGIN }, 'POST')).status, 405);
  assert.equal((await get('/lain')).status, 404);
  const noOrigin = await get('/live', {});
  assert.equal(noOrigin.status, 200, 'curl untuk uji tetap bisa');
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('worker: belum dikonfigurasi memberi pesan jelas; /health tidak memanggil penyedia', async () => {
  for (const env of [{ LIVE_API_KEY: '' }, { LIVE_PROVIDER: 'tidakada' }, { ALLOWED_ORIGINS: '' }]) {
    const { get, calls } = rig({ env });
    const res = await get('/live', {});
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /belum dikonfigurasi/);
    const h = await (await get('/health', {})).json();
    assert.equal(h.configured, false);
    assert.equal(calls.length, 0);
  }
  const ok = rig();
  const h = await (await ok.get('/health')).json();
  assert.deepEqual([h.configured, h.provider, h.keySet], [true, 'apifootball', true]);
  assert.ok(!JSON.stringify(h).includes(KEY));
});

test('worker: kesalahan penyedia tidak membocorkan kunci; data lama (<90 dtk) dipakai bila penyedia error', async () => {
  let t = T0;
  let mode = 'ok';
  const { get } = rig({
    now: () => t,
    body: () => (mode === 'ok' ? new Response(JSON.stringify(AF)) : mode === '403' ? new Response('{}', { status: 403 }) : mode === 'limit' ? new Response(JSON.stringify({ errors: { requests: `limit habis untuk ${KEY}` } })) : Promise.reject(new Error(`boom ${KEY}`))),
  });
  assert.equal((await get()).status, 200);
  t += 30_000; mode = '403';
  const stale = await (await get()).json();
  assert.equal(stale.stale, true, 'masih berumur < 90 detik');
  assert.equal(stale.events.length, 4);
  t += 120_000;
  for (const m of ['403', 'limit', 'throw']) {
    mode = m;
    const res = await get();
    const text = await res.text();
    assert.ok(res.status >= 429 && res.status < 600, `${m}: ${res.status}`);
    assert.ok(!text.includes(KEY), `${m}: kunci bocor`);
    assert.equal(JSON.parse(text).ok, false);
  }
  mode = '403';
  assert.match((await (await get()).json()).error, /HTTP 403/);
});

test('worker: titik masuk default berfungsi tanpa cache (Node)', async () => {
  const res = await worker.fetch(new Request('https://x.workers.dev/health'), { LIVE_PROVIDER: 'apifootball', LIVE_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN }, { waitUntil() {} });
  assert.equal((await res.json()).configured, true);
});

/* ------------------------------------------------------------------ sisi browser */

test('cleanProxyUrl: hanya https yang sah', () => {
  assert.equal(cleanProxyUrl(PROXY), PROXY);
  assert.equal(cleanProxyUrl(`  ${PROXY}#x `), PROXY);
  for (const bad of ['', null, undefined, 'http://a.workers.dev/live', 'https://user:pw@a.workers.dev/live', 'https://localhost/live', 'javascript:alert(1)', 'bukan url', 'ftp://a.b/c']) assert.equal(cleanProxyUrl(bad), null, String(bad));
});

test('parseProxy: menolak respons yang bukan dari proxy dan membuang baris rusak', () => {
  assert.throws(() => parseProxy(null));
  assert.throws(() => parseProxy({ ok: false, error: 'x' }));
  assert.throws(() => parseProxy({ ok: true }));
  const p = parseProxy({
    ok: true, label: 'API-Football', at: 5, events: [
      null, { home: 'A' }, { id: 'x', sport: 'football', home: 'A', away: 'B', hs: 1, as: 0, state: 'pre' },
      { id: 'af:1', sport: 'football', home: 'Man City', away: 'Arsenal', hs: 2, as: 1, state: 'in', minute: 67, period: 'Babak 2', kickoff: T0 },
    ],
  });
  assert.equal(p.events.length, 1);
  assert.equal(p.label, 'API-Football');
});

const mk = (over = {}) => ({
  id: 'tsdb:1', sport: 'football', league: 'English Premier League',
  home: { name: 'Manchester City' }, away: { name: 'Arsenal' },
  kickoff: new Date(T0 - 30 * MIN).toISOString(), status: 'upcoming', minute: null, period: null, progress: null, score: null,
  forecast: { home: 0.5, draw: 0.25, away: 0.25, pick: 'H', pickP: 0.5, confidence: 40, live: false },
  ...over,
});

test('overlayFromProxy: cocok lewat nama, cabang harus sama, kandang/tandang terbalik ditangani', () => {
  const { events } = parseProxy({ ok: true, events: normalizeApiFootball(AF).concat(normalizeTsdb(TS)) });
  const ov = overlayFromProxy(mk(), events);
  assert.deepEqual([ov.status, ov.score, ov.minute, ov.period], ['live', { home: 2, away: 1 }, 67, 'Babak 2']);
  assert.ok(Math.abs(ov.progress - 67 / 90) < 1e-9);
  // urutan terbalik di snapshot
  const sw = overlayFromProxy(mk({ home: { name: 'Arsenal' }, away: { name: 'Manchester City' } }), events);
  assert.deepEqual(sw.score, { home: 1, away: 2 });
  // turun minum dan selesai
  assert.deepEqual(overlayFromProxy(mk({ home: { name: 'Chelsea' }, away: { name: 'Liverpool' } }), events).progress, 0.5);
  const fin = overlayFromProxy(mk({ home: { name: 'Brighton' }, away: { name: 'Brentford' } }), events);
  assert.deepEqual([fin.status, fin.progress, fin.period], ['finished', 1, 'Selesai']);
  // cabang berbeda dengan nama mirip tidak boleh cocok
  assert.equal(overlayFromProxy(mk({ sport: 'basketball' }), events), null);
  // basket dari TSDB: tanpa jam mulai dianggap mulai sesuai snapshot
  const nba = overlayFromProxy(mk({ sport: 'basketball', league: 'NBA', home: { name: 'Los Angeles Lakers' }, away: { name: 'Boston Celtics' } }), events);
  assert.deepEqual([nba.status, nba.score, nba.period, nba.progress], ['live', { home: 54, away: 51 }, 'Q2', null]);
  assert.equal(overlayFromProxy(mk({ home: { name: 'Tim Lain' }, away: { name: 'Tim Asing' } }), events), null);
});

/* ------------------------------------------------------------------ pemantau dengan proxy */

const sportOf = (id) => { const s = SPORTS_BY_ID[id]; return s ? publicSport(s) : null; };
const ratings = { home: { rating: 1650, games: 30, gf: 60, ga: 20 }, away: { rating: 1600, games: 30, gf: 50, ga: 25 } };
const emptyForm = (name) => ({ name, matches: [], w: 0, d: 0, l: 0, gf: 0, ga: 0, n: 0 });
const PL = `${ESPN_ORIGIN}/apis/site/v2/sports/soccer/eng.1/scoreboard`;

function feedWith({ routes = {}, matches = [mk()], now = () => T0, proxyUrl = PROXY, proxyBody }) {
  const espn = fakeEspn(routes);
  const hits = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === PROXY) {
      hits.push({ url, init });
      const b = typeof proxyBody === 'function' ? proxyBody() : proxyBody;
      if (b instanceof Error) throw b;
      if (b?.status) return new Response(JSON.stringify(b.body ?? {}), { status: b.status });
      return new Response(JSON.stringify(b));
    }
    return espn(url, init);
  };
  const snap = { builtAt: new Date(T0 - 5 * MIN).toISOString(), matches };
  const changes = [];
  const feed = createLiveFeed({
    getSnapshot: async () => snap,
    getBundle: async (id) => ({ match: matches.find((m) => m.id === id), ratings, form: { home: emptyForm('a'), away: emptyForm('b') }, h2h: { matches: [], homeWins: 0, draws: 0, awayWins: 0 } }),
    sportOf, proxyUrl, model: { analyze, pickOf }, explain, fetchImpl, now, onChange: () => changes.push(1),
  });
  return { feed, snap, espn, hits, changes };
}
const proxyJson = (events, extra = {}) => ({ ok: true, provider: 'apifootball', label: 'API-Football', at: T0, events, ...extra });

test('pemantau: proxy menimpa ESPN, liveSrc memuat nama penyedia, permintaan tanpa header khusus', async () => {
  const espnEv = espnEvent({ id: '9', date: T0 - 30 * MIN, home: 'Manchester City', away: 'Arsenal', hs: 1, as: 1, clock: "60'", period: 2 });
  const { feed, snap, hits } = feedWith({ routes: { [PL]: board(espnEv) }, proxyBody: proxyJson(normalizeApiFootball(AF)) });
  const r = await feed.tick();
  assert.equal(r.ok, 2);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].init.headers, undefined, 'tanpa header = tanpa preflight CORS');
  assert.equal(hits[0].init.credentials, 'omit');
  const m = feed.applyList(snap).matches[0];
  assert.deepEqual([m.status, m.score, m.minute], ['live', { home: 2, away: 1 }, 67], 'skor proxy (2-1) mengalahkan ESPN (1-1)');
  assert.equal(m.liveSrc.name, 'API-Football');
  assert.equal(feed.status().state, 'live');
  assert.equal(feed.status().proxyOkAt, T0);
});

test('pemantau: proxy gagal -> ESPN tetap bekerja; cooldown mencegah menghantam proxy', async () => {
  let t = T0;
  const espnEv = espnEvent({ id: '9', date: T0 - 30 * MIN, home: 'Manchester City', away: 'Arsenal', hs: 1, as: 1, clock: "60'", period: 2 });
  const { feed, snap, hits } = feedWith({ now: () => t, routes: { [PL]: board(espnEv) }, proxyBody: { status: 403, body: { ok: false } } });
  await feed.tick();
  const m = feed.applyList(snap).matches[0];
  assert.deepEqual([m.score, m.liveSrc.name], [{ home: 1, away: 1 }, 'ESPN']);
  await feed.tick();
  assert.equal(hits.length, 1, 'masih dalam masa tunggu');
  t += 6 * MIN;
  await feed.tick();
  assert.equal(hits.length, 2, 'dicoba lagi setelah masa tunggu');
});

test('pemantau: proxy saja (tanpa ESPN) untuk laga yang tak ada di ESPN; data basi dari proxy diabaikan', async () => {
  const nba = mk({ id: 'tsdb:7', sport: 'basketball', league: 'Liga Tak Dikenal', home: { name: 'Los Angeles Lakers' }, away: { name: 'Boston Celtics' } });
  const a = feedWith({ matches: [nba], proxyBody: proxyJson(normalizeTsdb(TS), { provider: 'thesportsdb', label: 'TheSportsDB' }) });
  assert.equal((await a.feed.tick()).ok, 1);
  assert.equal(a.espn.calls.length, 0, 'tidak ada endpoint ESPN untuk cabang ini');
  const m = a.feed.applyList(a.snap).matches[0];
  assert.deepEqual([m.status, m.score, m.period, m.liveSrc.name], ['live', { home: 54, away: 51 }, 'Q2', 'TheSportsDB']);

  const b = feedWith({ matches: [nba], proxyBody: proxyJson(normalizeTsdb(TS), { stale: true }) });
  await b.feed.tick();
  assert.equal(b.feed.applyList(b.snap).matches[0].status, 'upcoming', 'data stale tidak dipakai');
});

test('pemantau: tanpa proxyUrl perilaku lama; proxy tidak ditanya bila tak ada laga yang dipantau', async () => {
  const a = feedWith({ proxyUrl: null, proxyBody: proxyJson([]) });
  await a.feed.tick();
  assert.equal(a.hits.length, 0);
  const far = mk({ kickoff: new Date(T0 + 6 * 3600_000).toISOString() });
  const b = feedWith({ matches: [far], proxyBody: proxyJson([]) });
  await b.feed.tick();
  assert.equal(b.hits.length, 0, 'tidak ada laga yang dekat: kuota dihemat');
  const c = feedWith({ proxyBody: new Error('jaringan putus') });
  await c.feed.tick();
  await c.feed.tick();
  assert.equal(c.hits.length, 1, 'gagal sekali -> masa tunggu');
  assert.notEqual(c.feed.status().state, 'live');
  assert.equal(c.feed.applyList(c.snap).matches[0].status, 'upcoming');
});

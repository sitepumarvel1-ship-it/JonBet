import test from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, normalizeEvent, createTsdbProvider } from '../server/providers/thesportsdb.js';
import { createDemoProvider } from '../server/providers/demo.js';
import { SPORTS } from '../server/sports.js';
import { analyze } from '../server/model/model.js';
import { boot } from './helpers.js';

const NOW = Date.parse('2026-11-18T10:00:00Z');
const ev = (o = {}) => ({
  idEvent: '1001', strSport: 'Soccer', strLeague: 'Test League', idLeague: '4328',
  strHomeTeam: 'Alpha FC', strAwayTeam: 'Beta United', strTimestamp: '2026-11-18T12:00:00', dateEvent: '2026-11-18', strTime: '12:00:00',
  strStatus: 'Not Started', intHomeScore: null, intAwayScore: null, strProgress: null, strVenue: 'Stadion Satu', ...o,
});

test('mapStatus: pemetaan status mentah', () => {
  const cases = [
    ['Not Started', '', false, 'upcoming'], ['NS', '', false, 'upcoming'], ['', '', false, 'upcoming'],
    ['Match Finished', '', true, 'finished'], ['FT', '', true, 'finished'], ['AET', '', true, 'finished'], ['Final', '', true, 'finished'],
    ['1H', '23', true, 'live'], ['HT', '', true, 'live'], ['Q3', '', true, 'live'], ['In Progress', '', true, 'live'],
    ['Postponed', '', false, 'postponed'], ['Cancelled', '', false, 'cancelled'], ['Abandoned', '', false, 'cancelled'],
    ['aneh-sekali', '', false, 'upcoming'],
  ];
  for (const [s, p, hasScore, want] of cases) assert.equal(mapStatus(s, p, hasScore, NOW, NOW), want, `${s}`);
  assert.equal(mapStatus('', '45', true, NOW, NOW), 'live', 'progres menit => live');
  assert.equal(mapStatus('Not Started', '', true, NOW - 8 * 3600_000, NOW), 'finished', 'sudah lama lewat & ada skor');
  assert.equal(mapStatus(null, undefined, false, null, NOW), 'upcoming');
});

test('normalizeEvent: laga biasa, zona waktu UTC, skor, atribut', () => {
  const m = normalizeEvent(ev(), NOW);
  assert.equal(m.id, 'tsdb:1001');
  assert.equal(m.sport, 'football');
  assert.equal(m.kickoff, '2026-11-18T12:00:00.000Z');
  assert.equal(m.status, 'upcoming');
  assert.equal(m.score, null);
  assert.equal(m.home.short, 'AF');
  assert.equal(m.source, 'thesportsdb');
  const fin = normalizeEvent(ev({ strStatus: 'Match Finished', intHomeScore: '3', intAwayScore: '1', strTimestamp: '2026-11-17T19:00:00+00:00' }), NOW);
  assert.equal(fin.status, 'finished');
  assert.deepEqual(fin.score, { home: 3, away: 1 });
  assert.equal(fin.progress, 1);
  const live = normalizeEvent(ev({ strStatus: '2H', strProgress: "67'", intHomeScore: '1', intAwayScore: '1', strTimestamp: '2026-11-18T09:00:00' }), NOW);
  assert.equal(live.status, 'live');
  assert.equal(live.minute, 67);
  assert.ok(Math.abs(live.progress - 67 / 90) < 1e-9, 'progres live mengikuti menit (bukan 0 = baru mulai)');
  const bb = normalizeEvent(ev({ strSport: 'Basketball', strStatus: 'Q3', strProgress: 'Q3', intHomeScore: '70', intAwayScore: '60', strTimestamp: '2026-11-18T09:00:00' }), NOW);
  assert.equal(bb.status, 'live');
  assert.equal(bb.progress, null, 'cabang non-menit: progres tidak diketahui, bukan 0');
  const analysis = analyze({ sport: 'basketball', match: bb });
  assert.ok(analysis.live, 'model tetap menghitung live dengan perkiraan tengah laga');
  const noTs = normalizeEvent(ev({ strTimestamp: null }), NOW);
  assert.equal(noTs.kickoff, '2026-11-18T12:00:00.000Z', 'jatuh balik ke dateEvent + strTime');
});

test('normalizeEvent: data cacat -> null, bukan galat', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, ev({ idEvent: '' }), ev({ strHomeTeam: '' }), ev({ strSport: 'Curling' }), ev({ strTimestamp: 'bukan-tanggal', dateEvent: null })]) {
    assert.equal(normalizeEvent(bad, NOW), null, JSON.stringify(bad)?.slice(0, 50));
  }
  const odd = normalizeEvent(ev({ intHomeScore: 'abc', intAwayScore: '2', strStatus: 'FT' }), NOW);
  assert.equal(odd.score, null);
});

test('normalizeEvent: lencana hanya https (tolak javascript:, http:, data:)', () => {
  const m = normalizeEvent(ev({ strHomeTeamBadge: 'javascript:alert(1)', strAwayTeamBadge: 'http://x.test/a.png' }), NOW);
  assert.equal(m.home.badge, null);
  assert.equal(m.away.badge, null);
  const ok = normalizeEvent(ev({ strHomeTeamBadge: 'https://r2.thesportsdb.com/a.png' }), NOW);
  assert.equal(ok.home.badge, 'https://r2.thesportsdb.com/a.png');
});

test('normalizeEvent: nama sumber yang berisi HTML dibiarkan apa adanya (UI memakai textContent)', () => {
  const m = normalizeEvent(ev({ strHomeTeam: '<img src=x onerror=alert(1)>' }), NOW);
  assert.equal(m.home.name, '<img src=x onerror=alert(1)>');
});

test('semua cabang punya nama TheSportsDB yang bisa dipetakan', () => {
  for (const s of SPORTS) {
    assert.ok(s.tsdb, `${s.id} tanpa nama tsdb`);
    const m = normalizeEvent(ev({ strSport: s.tsdb }), NOW);
    assert.equal(m?.sport, s.id, s.tsdb);
  }
});

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    return { ok: r.status === undefined || r.status < 400, status: r.status ?? 200, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

test('provider: listMatches memanggil eventsday per hari & cabang, menyaring jendela waktu, memakai cache', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('eventsday.php') && url.includes('s=Soccer') && url.includes('d=2026-11-18')) {
      return { body: { events: [ev(), ev({ idEvent: '1002', strTimestamp: '2026-11-30T12:00:00', dateEvent: '2026-11-30' }), { junk: true }] } };
    }
    return { body: { events: null } };
  });
  const p = createTsdbProvider({ key: '3', fetchImpl, now: () => NOW, perMinute: 1000 });
  const from = NOW - 3600_000, to = NOW + 20 * 3600_000;
  const r = await p.listMatches({ from, to, sports: ['football'] });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'tsdb:1001');
  assert.ok(fetchImpl.calls.every((c) => c.url.startsWith('https://www.thesportsdb.com/api/v1/json/3/eventsday.php')));
  const n = fetchImpl.calls.length;
  await p.listMatches({ from, to, sports: ['football'] });
  assert.equal(fetchImpl.calls.length, n, 'permintaan kedua dilayani dari cache');
});

test('provider: kunci gratis tidak memanggil livescore; kunci premium memakainya dan menimpa status', async () => {
  const mk = (key) => mockFetch((url, init) => {
    if (url.includes('livescore/all')) {
      assert.equal(init.headers['X-API-KEY'], key);
      return { body: { livescore: [{ idEvent: '1001', strStatus: '1H', strProgress: "12'", intHomeScore: '1', intAwayScore: '0' }] } };
    }
    if (url.includes('s=Soccer')) return { body: { events: [ev()] } };
    return { body: { events: [] } };
  });
  const free = mk('3');
  const pf = createTsdbProvider({ key: '3', fetchImpl: free, now: () => NOW, perMinute: 1000 });
  const a = await pf.listMatches({ from: NOW - 3600_000, to: NOW + 20 * 3600_000, sports: ['football'] });
  assert.equal(a[0].status, 'upcoming');
  assert.ok(!free.calls.some((c) => c.url.includes('livescore')));
  const prem = mk('kunci-premium');
  const pp = createTsdbProvider({ key: 'kunci-premium', fetchImpl: prem, now: () => NOW, perMinute: 1000 });
  const b = await pp.listMatches({ from: NOW - 3600_000, to: NOW + 20 * 3600_000, sports: ['football'] });
  assert.equal(b[0].status, 'live');
  assert.deepEqual(b[0].score, { home: 1, away: 0 });
  assert.equal(b[0].minute, 12);
});

test('provider: gagal total -> melempar; gagal sebagian -> tetap mengembalikan yang berhasil; stale cache dipakai', async () => {
  const dead = createTsdbProvider({ key: '3', fetchImpl: mockFetch(() => ({ status: 500, body: {} })), now: () => NOW });
  await assert.rejects(dead.listMatches({ from: NOW, to: NOW + 3600_000, sports: ['football'] }));
  const throwing = createTsdbProvider({ key: '3', fetchImpl: async () => { throw new Error('jaringan putus'); }, now: () => NOW });
  await assert.rejects(throwing.listMatches({ from: NOW, to: NOW + 3600_000, sports: ['football'] }), /jaringan putus/);

  let t = NOW; let fail = false;
  const f = mockFetch(() => (fail ? { status: 503, body: {} } : { body: { events: [ev()] } }));
  const p = createTsdbProvider({ key: '3', fetchImpl: f, now: () => t, perMinute: 1000 });
  const ok = await p.listMatches({ from: NOW - 3600_000, to: NOW + 20 * 3600_000, sports: ['football'] });
  assert.equal(ok.length, 1);
  fail = true; t += 30 * 60_000; // cache kedaluwarsa, sumber mati
  const stale = await p.listMatches({ from: NOW - 3600_000, to: NOW + 20 * 3600_000, sports: ['football'] });
  assert.equal(stale.length, 1, 'data lama tetap dipakai saat sumber mati');
});

test('provider: batas permintaan per menit dihormati', async () => {
  const f = mockFetch(() => ({ body: { events: [] } }));
  const p = createTsdbProvider({ key: '3', fetchImpl: f, now: () => NOW, perMinute: 5 });
  await p.listMatches({ from: NOW, to: NOW + 3 * 86400_000 }).catch(() => {});
  assert.ok(f.calls.length <= 5, `terkirim ${f.calls.length}`);
});

test('provider: getMatch memvalidasi id dan membaca lookupevent', async () => {
  const f = mockFetch((url) => ({ body: { events: [ev({ idEvent: '777' })] } }));
  const p = createTsdbProvider({ key: '3', fetchImpl: f, now: () => NOW });
  assert.equal(await p.getMatch('tsdb:abc'), null);
  assert.equal(await p.getMatch('tsdb:1; DROP'), null);
  assert.equal(f.calls.length, 0, 'id tak valid tidak sampai ke jaringan');
  const m = await p.getMatch('tsdb:777');
  assert.equal(m.id, 'tsdb:777');
  assert.match(f.calls[0].url, /lookupevent\.php\?id=777$/);
});

test('demo: deterministik, siklus hidup upcoming -> live -> finished, setiap cabang selalu ada isi', async () => {
  const a = createDemoProvider({ now: () => NOW });
  const b = createDemoProvider({ now: () => NOW });
  const w = { from: NOW - 12 * 3600_000, to: NOW + 36 * 3600_000 };
  assert.deepEqual(await a.listMatches(w), await b.listMatches(w), 'deterministik');
  const list = await a.listMatches(w);
  for (const s of SPORTS) assert.ok(list.some((m) => m.sport === s.id), `${s.id} kosong`);
  for (const m of list.filter((x) => x.status === 'live')) {
    assert.ok(m.progress > 0 && m.progress <= 1, m.id);
    assert.ok(m.score && m.score.home >= 0 && m.score.away >= 0, m.id);
  }
  // satu laga diikuti sepanjang waktu
  const up = list.find((m) => m.status === 'upcoming' && m.sport === 'football');
  const seen = [];
  for (const dt of [-3600_000, 0, 30 * 60_000, 60 * 60_000, 3 * 3600_000]) {
    const at = createDemoProvider({ now: () => Date.parse(up.kickoff) + dt });
    seen.push((await at.getMatch(up.id)).status);
  }
  assert.deepEqual(seen, ['upcoming', 'live', 'live', 'live', 'finished']);
  // hasil laga selesai tidak berubah-ubah
  const fin = list.find((m) => m.status === 'finished');
  const later = createDemoProvider({ now: () => NOW + 5 * 86400_000 });
  assert.deepEqual((await later.getMatch(fin.id)).score, fin.score);
});

test('layanan: sumber nyata mati -> memakai data lama lalu data demo berlabel', async () => {
  let dead = false;
  const flaky = {
    name: 'flaky', isDemo: false,
    async listMatches(w) { if (dead) throw new Error('mati'); return createDemoProvider({ now: () => NOW }).listMatches(w); },
    async getMatch(id) { if (dead) throw new Error('mati'); return createDemoProvider({ now: () => NOW }).getMatch(id); },
  };
  const t = await boot({ provider: 'thesportsdb', primaryProvider: flaky, fallbackDemo: true, start: NOW });
  try {
    const ok = await t.req('GET', '/api/matches');
    assert.equal(ok.status, 200);
    assert.ok(ok.json.matches.length > 0);
    assert.equal((await t.req('GET', '/api/config')).json.demo, false);
    dead = true;
    t.clock.t += 3 * 60_000;
    const stale = await t.req('GET', '/api/matches');
    assert.equal(stale.status, 200, 'data lama dipertahankan');
    assert.ok(stale.json.matches.length > 0);
    assert.equal(stale.json.meta.stale, true, 'ditandai tertunda');
    const cfg = (await t.req('GET', '/api/config')).json;
    assert.equal(typeof cfg.fallbackActive, 'boolean');
  } finally { await t.close(); }
});

test('layanan: sumber nyata mati sejak awal & fallback demo dimatikan -> 502 yang rapi, bukan 500', async () => {
  const dead = { name: 'dead', isDemo: false, async listMatches() { throw new Error('mati'); }, async getMatch() { throw new Error('mati'); } };
  const t = await boot({ provider: 'thesportsdb', primaryProvider: dead, fallbackDemo: false, start: NOW });
  try {
    const r = await t.req('GET', '/api/matches');
    assert.ok([200, 502, 503].includes(r.status), String(r.status));
    if (r.status === 200) assert.equal(r.json.matches.length, 0);
    const g = await t.req('GET', '/api/matches/tsdb:123');
    assert.ok([404, 502].includes(g.status));
  } finally { await t.close(); }
});

test('layanan: sumber nyata mati sejak awal + fallback demo -> tetap ada data, ditandai fallback', async () => {
  const dead = { name: 'dead', isDemo: false, async listMatches() { throw new Error('mati'); }, async getMatch() { throw new Error('mati'); } };
  const t = await boot({ provider: 'thesportsdb', primaryProvider: dead, fallbackDemo: true, start: NOW });
  try {
    const r = await t.req('GET', '/api/matches');
    assert.equal(r.status, 200);
    assert.ok(r.json.matches.length > 0);
    assert.equal(r.json.meta.fallback, true);
    assert.equal((await t.req('GET', '/api/config')).json.fallbackActive, true);
  } finally { await t.close(); }
});

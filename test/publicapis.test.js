// Tes sumber data publik tanpa kunci (OpenLigaDB, MLB, NHL) dengan respons buatan; tanpa jaringan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicProvider, MLB_LEVELS, parseMlb, parseNhl, parseOpenLiga } from '../server/providers/publicapis.js';
import { createCompositeProvider } from '../server/providers/composite.js';
import { SPORTS_BY_ID } from '../server/sports.js';

const NOW = Date.parse('2026-11-19T18:00:00Z');
const H = 3_600_000;
const iso = (o) => new Date(NOW + o * H).toISOString();

const olMatch = (id, t1, t2, off, { finished = false, final = null, goals = [] } = {}) => ({
  matchID: id, matchDateTimeUTC: iso(off), leagueName: '1. Fußball-Bundesliga 2026/2027', team1: { teamName: t1, shortName: '' }, team2: { teamName: t2, shortName: 'XYZ' },
  matchIsFinished: finished, matchResults: final ? [{ resultTypeID: 1, pointsTeam1: 0, pointsTeam2: 0 }, { resultTypeID: 2, pointsTeam1: final[0], pointsTeam2: final[1] }] : [], goals, location: { locationStadium: 'Allianz Arena' },
});
const OL = [
  olMatch(1, 'FC Bayern München', 'Borussia Dortmund', -30, { finished: true, final: [3, 2] }),
  olMatch(2, 'RB Leipzig', 'Bayer 04 Leverkusen', -1, { goals: [{ scoreTeam1: 1, scoreTeam2: 0 }, { scoreTeam1: 1, scoreTeam2: 1 }, { scoreTeam1: 2, scoreTeam2: 1 }] }),
  olMatch(3, 'VfB Stuttgart', 'SC Freiburg', 20),
  olMatch(4, 'Werder Bremen', 'FC Augsburg', -8), // lewat jam mulai, belum ditandai selesai: data tertinggal
  olMatch(5, 'Hamburger SV', 'Mainz 05', -40, { finished: true }), // selesai tanpa hasil
  { matchID: 6, team1: { teamName: 'A' }, team2: { teamName: 'B' } }, // tanpa jam
];

test('OpenLigaDB: selesai, live dari gol terakhir, akan datang; data tertinggal dan rusak dibuang', () => {
  const r = parseOpenLiga(OL, 'German Bundesliga', 'openliga/bl1', NOW);
  assert.deepEqual(r.map((m) => m.id), ['pub:ol-1', 'pub:ol-2', 'pub:ol-3']);
  const [fin, live, up] = r;
  assert.deepEqual([fin.status, fin.score, fin.period, fin.sport, fin.league, fin.venue], ['finished', { home: 3, away: 2 }, 'Selesai', 'football', 'German Bundesliga', 'Allianz Arena']);
  assert.deepEqual([live.status, live.score, live.period], ['live', { home: 2, away: 1 }, 'Live']);
  assert.ok(live.progress > 0 && live.progress < 1);
  assert.deepEqual([up.status, up.score], ['upcoming', null]);
  assert.equal(fin.home.short, 'FBM', 'singkatan dari inisial bila shortName kosong');
  assert.equal(fin.away.short, 'XYZ', 'shortName dipakai bila ada');
  for (const m of r) { assert.ok(SPORTS_BY_ID[m.sport]); assert.equal(m.source, 'public'); assert.ok(m.kickoff.endsWith('Z')); }
  assert.deepEqual(parseOpenLiga(null, 'x', 'y', NOW), []);
  assert.deepEqual(parseOpenLiga({ a: 1 }, 'x', 'y', NOW), []);
});

const mlbGame = (pk, away, home, off, abstract, detailed, extra = {}) => ({
  gamePk: pk, gameDate: iso(off), status: { abstractGameState: abstract, detailedState: detailed },
  teams: { away: { team: { name: away }, score: extra.as }, home: { team: { name: home }, score: extra.hs } }, venue: { name: 'Fenway Park' }, linescore: extra.linescore,
});
const MLB = { dates: [{ date: '2026-11-19', games: [
  mlbGame(1, 'New York Yankees', 'Boston Red Sox', -5, 'Final', 'Final', { as: 4, hs: 5 }),
  mlbGame(2, 'Chicago Cubs', 'St. Louis Cardinals', -2, 'Live', 'In Progress', { as: 1, hs: 3, linescore: { currentInning: 6, inningState: 'Bottom' } }),
  mlbGame(3, 'Texas Rangers', 'Houston Astros', 4, 'Preview', 'Scheduled'),
  mlbGame(4, 'Seattle Mariners', 'Oakland Athletics', -1, 'Preview', 'Postponed'),
  mlbGame(5, 'A', 'B', -3, 'Final', 'Final', {}), // selesai tanpa skor
  mlbGame(6, 'C', 'D', 1, 'Aneh', 'Aneh'),
] }] };

test('MLB: status, inning, skor, ditunda; baris tanpa skor atau status asing dibuang', () => {
  const r = parseMlb(MLB);
  assert.deepEqual(r.map((m) => m.id), ['pub:mlb-1', 'pub:mlb-2', 'pub:mlb-3', 'pub:mlb-4']);
  const [fin, live, up, ppd] = r;
  assert.deepEqual([fin.status, fin.score, fin.league, fin.sport], ['finished', { home: 5, away: 4 }, 'MLB', 'baseball']);
  assert.deepEqual([live.status, live.score, live.period], ['live', { home: 3, away: 1 }, 'Bawah 6']);
  assert.ok(Math.abs(live.progress - 5.5 / 9) < 1e-9);
  assert.equal(up.status, 'upcoming');
  assert.equal(ppd.status, 'postponed');
  assert.deepEqual(parseMlb({}), []);
});

const nhlGame = (id, away, home, off, state, extra = {}) => ({
  id, startTimeUTC: iso(off), gameState: state, awayTeam: { name: { default: away[1] }, placeName: { default: away[0] }, abbrev: away[2], score: extra.as }, homeTeam: { name: { default: home[1] }, placeName: { default: home[0] }, abbrev: home[2], score: extra.hs },
  periodDescriptor: extra.pd, clock: extra.clock,
});
const NHL = { games: [
  nhlGame(10, ['Boston', 'Bruins', 'BOS'], ['Toronto', 'Maple Leafs', 'TOR'], -4, 'OFF', { as: 2, hs: 3 }),
  nhlGame(11, ['Montréal', 'Canadiens', 'MTL'], ['Chicago', 'Blackhawks', 'CHI'], -1, 'LIVE', { as: 0, hs: 1, pd: { number: 2, periodType: 'REG' }, clock: { timeRemaining: '05:00', inIntermission: false } }),
  nhlGame(12, ['Dallas', 'Stars', 'DAL'], ['Vegas', 'Golden Knights', 'VGK'], -1, 'CRIT', { as: 2, hs: 2, pd: { number: 4, periodType: 'OT' }, clock: { timeRemaining: '02:10' } }),
  nhlGame(13, ['Ottawa', 'Senators', 'OTT'], ['Utah', 'Mammoth', 'UTA'], 5, 'FUT'),
  nhlGame(14, ['X', 'Y', 'XY'], ['Z', 'W', 'ZW'], 1, 'ZZZ'),
] };

test('NHL: nama lengkap kota+tim, babak, menit dari sisa waktu, perpanjangan', () => {
  const r = parseNhl(NHL);
  assert.deepEqual(r.map((m) => m.id), ['pub:nhl-10', 'pub:nhl-11', 'pub:nhl-12', 'pub:nhl-13']);
  const [fin, live, ot, up] = r;
  assert.deepEqual([fin.home.name, fin.away.name, fin.status, fin.score, fin.home.short], ['Toronto Maple Leafs', 'Boston Bruins', 'finished', { home: 3, away: 2 }, 'TOR']);
  assert.deepEqual([live.status, live.period, live.minute, live.score], ['live', 'Babak 2', 35, { home: 1, away: 0 }]);
  assert.ok(Math.abs(live.progress - (1 + 0.75) / 3) < 1e-9);
  assert.deepEqual([ot.period, ot.score], ['Perpanjangan', { home: 2, away: 2 }]);
  assert.equal(up.status, 'upcoming');
});

/* ------------------------------------------------------------------ penyedia */

function router(over = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [re, body] of Object.entries(over)) if (new RegExp(re).test(u)) {
      if (body instanceof Error) throw body;
      if (body?.status) return new Response('{}', { status: body.status });
      return new Response(JSON.stringify(body));
    }
    if (u.includes('openligadb') && u.includes('/bl1/')) return new Response(JSON.stringify(OL));
    if (u.includes('openligadb')) return new Response('[]');
    if (u.includes('statsapi.mlb.com')) return new Response(JSON.stringify(MLB));
    if (u.includes('api-web.nhle.com')) return new Response(JSON.stringify(u.endsWith('2026-11-19') ? NHL : { games: [] }));
    return new Response('{}', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}
const WINDOW = { from: NOW - 6 * H, to: NOW + 30 * H };

test('penyedia publik: gabungan tiga sumber, jendela waktu, laporan per sumber, getMatch', async () => {
  const net = router();
  const p = createPublicProvider({ fetchImpl: net, now: () => NOW });
  const list = await p.listMatches(WINDOW);
  const ids = list.map((m) => m.id).sort();
  assert.deepEqual(ids, ['pub:mlb-1', 'pub:mlb-2', 'pub:mlb-3', 'pub:mlb-4', 'pub:nhl-10', 'pub:nhl-11', 'pub:nhl-12', 'pub:nhl-13', 'pub:ol-2', 'pub:ol-3'].sort(), 'pub:ol-1 (30 jam lalu) di luar jendela');
  assert.deepEqual(p.report.sources.openligadb, { ok: true, events: 2 });
  assert.equal(p.report.sources.mlb.ok, true);
  assert.equal(p.owns('pub:ol-2'), true);
  assert.equal(p.owns('espn:1'), false);
  assert.equal((await p.getMatch('pub:ol-2')).home.name, 'RB Leipzig');
  assert.equal(await p.getMatch('pub:ol-999'), null);
  for (const u of net.calls) assert.ok(/^https:\/\/(api\.openligadb\.de|statsapi\.mlb\.com|api-web\.nhle\.com)\//.test(u), u);
});

test('penyedia publik: filter cabang menghemat permintaan; musim OpenLigaDB mengikuti tanggal', async () => {
  const net = router();
  const p = createPublicProvider({ fetchImpl: net, now: () => NOW });
  assert.deepEqual(await p.listMatches({ ...WINDOW, sports: ['tennis'] }), []);
  assert.equal(net.calls.length, 0, 'cabang yang tak dicakup: tanpa permintaan');
  const b = await p.listMatches({ ...WINDOW, sports: ['baseball'] });
  assert.ok(b.length && b.every((m) => m.sport === 'baseball'));
  assert.ok(net.calls.every((u) => u.includes('statsapi')));
  const net2 = router();
  await createPublicProvider({ fetchImpl: net2, now: () => NOW }).listMatches({ ...WINDOW, sports: ['football'] });
  assert.ok(net2.calls.some((u) => u.endsWith('/getmatchdata/bl1/2026')), net2.calls.join('\n')); // November 2026 = musim 2026/27
  assert.ok(!net2.calls.some((u) => u.endsWith('/bl1/2025')));
  const jan = Date.parse('2027-02-10T12:00:00Z');
  const net3 = router();
  await createPublicProvider({ fetchImpl: net3, now: () => jan }).listMatches({ from: jan - H, to: jan + H, sports: ['football'] });
  assert.ok(net3.calls.some((u) => u.endsWith('/bl1/2026')) && !net3.calls.some((u) => u.endsWith('/bl1/2027')), 'Februari 2027 masih musim 2026/27');
});

test('penyedia publik: satu sumber gagal tidak menggagalkan yang lain; semuanya gagal = galat jelas', async () => {
  const p = createPublicProvider({ fetchImpl: router({ 'statsapi': { status: 503 }, 'api-web\\.nhle': new Error('ECONNRESET') }), now: () => NOW });
  const list = await p.listMatches(WINDOW);
  assert.ok(list.every((m) => m.id.startsWith('pub:ol-')) && list.length === 2);
  assert.equal(p.report.sources.mlb.ok, false);
  assert.match(p.report.sources.mlb.error, /HTTP 503/);
  assert.match(p.report.sources.nhl.error, /ECONNRESET/);
  const dead = createPublicProvider({ fetchImpl: async () => new Response('x', { status: 403 }), now: () => NOW });
  await assert.rejects(() => dead.listMatches(WINDOW), /Sumber publik tidak merespons/);
  assert.equal(dead.report.sources.openligadb.ok, false);
});

test('penyedia publik: respons sampah tidak melempar galat tak terduga', async () => {
  const junk = createPublicProvider({ fetchImpl: async () => new Response('<html>bukan json</html>'), now: () => NOW });
  await assert.rejects(() => junk.listMatches(WINDOW), /Sumber publik tidak merespons/);
  const weird = createPublicProvider({ fetchImpl: async () => new Response(JSON.stringify({ dates: 5, games: 'x', response: null })), now: () => NOW });
  assert.deepEqual(await weird.listMatches({ ...WINDOW, sports: ['baseball'] }), []);
});

test('komposit tiga lapis: ESPN > publik > TheSportsDB; duplikat dibuang menurut prioritas; getMatch ke pemilik id', async () => {
  const mkm = (id, sport, home, away, off, src) => ({ id, sport, league: 'L', home: { name: home }, away: { name: away }, kickoff: iso(off), status: 'upcoming', score: null, source: src });
  const espn = { name: 'espn', owns: (id) => id.startsWith('espn:'), listMatches: async () => [mkm('espn:1', 'baseball', 'Boston Red Sox', 'New York Yankees', -5, 'espn')], getMatch: async (id) => ({ id, from: 'espn' }) };
  const tsdb = { name: 'thesportsdb', owns: (id) => id.startsWith('tsdb:'), listMatches: async () => [mkm('tsdb:9', 'baseball', 'Chicago Cubs', 'St. Louis Cardinals', -2, 'tsdb'), mkm('tsdb:8', 'tennis', 'Rafa', 'Roger', 3, 'tsdb')], getMatch: async (id) => ({ id, from: 'tsdb' }) };
  const pub = createPublicProvider({ fetchImpl: router(), now: () => NOW });
  const all = createCompositeProvider({ primary: espn, secondary: createCompositeProvider({ primary: pub, secondary: tsdb }) });
  const list = await all.listMatches(WINDOW);
  const byId = new Map(list.map((m) => [m.id, m]));
  assert.ok(byId.has('espn:1'));
  assert.ok(!byId.has('pub:mlb-1'), 'Red Sox-Yankees sudah ada dari ESPN');
  assert.ok(byId.has('pub:mlb-2') && !byId.has('tsdb:9'), 'Cubs-Cardinals: versi publik mengalahkan TheSportsDB');
  assert.ok(byId.has('tsdb:8'), 'tenis hanya dari TheSportsDB');
  assert.equal((await all.getMatch('espn:1')).from, 'espn');
  assert.equal((await all.getMatch('tsdb:8')).from, 'tsdb');
  assert.equal((await all.getMatch('pub:ol-2')).home.name, 'RB Leipzig');
  assert.ok(all.report.espn.ok);
});

test('baseball bertingkat: tiap tingkat (MLB, MiLB, NPB, KBO, dst.) satu permintaan, liga diberi label tingkatnya, satu gagal tak mengganggu yang lain', async () => {
  const game = (pk, away, home) => ({ gamePk: pk, gameDate: iso(4), status: { abstractGameState: 'Preview', detailedState: 'Scheduled' }, teams: { away: { team: { name: away } }, home: { team: { name: home } } } });
  const asked = [];
  const impl = async (url) => {
    const u = String(url);
    asked.push(u);
    const id = Number(/sportId=(\d+)/.exec(u)?.[1]);
    if (id === 32) return new Response('x', { status: 503 });
    return new Response(JSON.stringify({ dates: [{ games: [game(1000 + id, `Tamu ${id}`, `Tuan ${id}`)] }] }));
  };
  const p = createPublicProvider({ fetchImpl: impl, now: () => NOW });
  const rows = await p.listMatches({ ...WINDOW, sports: ['baseball'] });
  assert.deepEqual([...new Set(asked.map((u) => Number(/sportId=(\d+)/.exec(u)[1])))].sort((a, b) => a - b), MLB_LEVELS.map(([id]) => id).sort((a, b) => a - b));
  assert.equal(asked.length, MLB_LEVELS.length, 'satu permintaan per tingkat');
  assert.ok(asked.every((u) => /^https:\/\/statsapi\.mlb\.com\/api\/v1\/schedule\?sportId=\d+&startDate=\d{4}-\d{2}-\d{2}&endDate=\d{4}-\d{2}-\d{2}&hydrate=linescore$/.test(u)));
  const by = Object.fromEntries(rows.map((m) => [m.id, m]));
  assert.equal(by['pub:mlb-1001'].league, 'MLB');
  assert.equal(by['pub:mlb-1011'].league, 'MiLB Triple-A');
  assert.equal(by['pub:mlb-1031'].league, 'NPB (Jepang)');
  assert.equal(by['pub:mlb-1051'].league, 'Baseball internasional');
  assert.ok(!by['pub:mlb-1032'], 'KBO gagal: tidak ada laganya');
  assert.equal(rows.length, MLB_LEVELS.length - 1);
  assert.deepEqual(p.report.sources.kbo.ok, false);
  assert.match(p.report.sources.kbo.error, /HTTP 503/);
  assert.equal(p.report.sources.npb.ok, true);
  assert.equal(p.report.sources.npb.events, 1);
  assert.ok(rows.every((m) => m.sport === 'baseball' && /^pub:mlb-\d+$/.test(m.id)));
});

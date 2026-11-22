// Tes statistik lengkap per laga (ESPN ringkasan, MLB, NHL) dengan respons buatan; tanpa jaringan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStatsProvider, parseEspnSummary, parseMlbBoxscore, parseNhlLanding, parseNhlRightRail, parseStatValue } from '../server/providers/matchstats.js';
import { enrichStats } from '../scripts/build-pages.mjs';

const stat = (name, displayValue, label = name) => ({ name, displayValue, label });
const SUMMARY = {
  header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: '10' } }, { homeAway: 'away', team: { id: '20' } }] }] },
  boxscore: { teams: [
    // sengaja urutan terbalik: tandang dulu, penentu sisi adalah homeAway
    { team: { id: '20' }, homeAway: 'away', statistics: [stat('possessionPct', '41.5'), stat('totalShots', '9'), stat('shotsOnTarget', '3'), stat('yellowCards', '2'), stat('passPct', '0.78', 'Pass Pct'), stat('odd', 'abc'), stat('fieldGoalsMade-fieldGoalsAttempted', '3-7', 'FG')] },
    { team: { id: '10' }, homeAway: 'home', statistics: [stat('possessionPct', '58.5'), stat('totalShots', '14'), stat('shotsOnTarget', '6'), stat('yellowCards', '1'), stat('passPct', '0.91', 'Pass Pct'), stat('odd', '12'), stat('fieldGoalsMade-fieldGoalsAttempted', '10-20', 'FG'), stat('onlyHome', '5')] },
  ] },
  keyEvents: [
    { type: { text: 'Goal' }, scoringPlay: true, team: { id: '10' }, clock: { displayValue: "23'" }, participants: [{ athlete: { displayName: 'Erling Haaland' } }] },
    { type: { text: 'Yellow Card' }, team: { id: '20' }, clock: { displayValue: "45'+2'" }, participants: [{ athlete: { displayName: 'Bukayo Saka' } }] },
    { type: { text: 'Substitution' }, team: { id: '20' }, clock: { displayValue: "60'" } },
    { type: { text: 'Goal' }, scoringPlay: true, team: { id: '99' }, clock: { displayValue: "70'" } }, // tim tak dikenal: dibuang
    { type: { text: 'Red Card' }, team: { id: '20' }, clock: { displayValue: "88'" } },
  ],
  leaders: [
    { team: { id: '10' }, leaders: [{ displayName: 'Goals', leaders: [{ displayValue: '2', athlete: { displayName: 'Erling Haaland' } }] }] },
    { team: { id: '20' }, leaders: [{ displayName: 'Goals', leaders: [{ displayValue: '1', athlete: { displayName: 'Bukayo Saka' } }] }, { displayName: 'Assists', leaders: [] }] },
  ],
};

test('parseStatValue: angka, persen, berhasil-percobaan, sampah', () => {
  assert.deepEqual(parseStatValue('55.2'), { n: 55.2 });
  assert.deepEqual(parseStatValue('62%'), { n: 62, unit: '%' });
  assert.deepEqual(parseStatValue('3-7'), { n: 3, made: true });
  assert.deepEqual(parseStatValue(4), { n: 4 });
  for (const bad of ['abc', '', null, undefined, NaN, {}, '1.2.3']) assert.equal(parseStatValue(bad), null, String(bad));
});

test('ESPN ringkasan: sisi dari homeAway (bukan urutan), label Indonesia, baris tak sepasang atau bukan angka dibuang', () => {
  const r = parseEspnSummary(SUMMARY);
  const by = Object.fromEntries(r.stats.map((s) => [s.label, s]));
  assert.deepEqual(by['Penguasaan bola'], { label: 'Penguasaan bola', home: 58.5, away: 41.5, unit: '%' });
  assert.deepEqual(by['Akurasi umpan'], { label: 'Akurasi umpan', home: 91, away: 78, unit: '%' }, 'pecahan 0-1 menjadi persen');
  assert.deepEqual([by.Tembakan.home, by.Tembakan.away], [14, 9]);
  assert.deepEqual([by['Kartu kuning'].home, by['Kartu kuning'].away], [1, 2]);
  assert.ok(by['Field goal berhasil'] === undefined && r.stats.some((s) => /berhasil/.test(s.label)), 'format x-y: berhasil, label diberi penanda');
  assert.ok(!r.stats.some((s) => s.label === 'odd' || s.label === 'onlyHome'));
  assert.equal(r.stats.length <= 14, true);
  assert.deepEqual(r.events.map((e) => [e.type, e.side, e.minute, e.player]), [['goal', 'home', 23, 'Erling Haaland'], ['yellow', 'away', 47, 'Bukayo Saka'], ['red', 'away', 88, null]]);
  assert.equal(r.events[1].clock, "45'+2'");
  assert.deepEqual(r.leaders, [{ label: 'Goals', home: { player: 'Erling Haaland', value: '2' }, away: { player: 'Bukayo Saka', value: '1' } }]);
});

test('ESPN ringkasan: bentuk rusak atau kosong tidak melempar galat', () => {
  for (const j of [null, {}, [], 'x', { boxscore: 5 }, { boxscore: { teams: [{}, {}] } }, { keyEvents: 'a', leaders: 3 }]) {
    const r = parseEspnSummary(j);
    assert.deepEqual([r.stats, r.events, r.leaders], [[], [], []]);
  }
  // tanpa boxscore, hanya header + kejadian: kejadian tetap terbaca
  const only = parseEspnSummary({ header: SUMMARY.header, keyEvents: SUMMARY.keyEvents });
  assert.equal(only.stats.length, 0);
  assert.equal(only.events.length, 3);
});

test('MLB boxscore: statistik pukulan dipasangkan; field hilang dilewati', () => {
  const j = { teams: { home: { teamStats: { batting: { hits: 9, homeRuns: 2, rbi: 5, baseOnBalls: 3, strikeOuts: 8, leftOnBase: 7, doubles: null } } }, away: { teamStats: { batting: { hits: 6, homeRuns: 1, rbi: 3, baseOnBalls: 2, strikeOuts: 11, leftOnBase: 5, doubles: 1 } } } } };
  const r = parseMlbBoxscore(j);
  assert.deepEqual(r.stats.find((s) => s.label === 'Hit'), { label: 'Hit', home: 9, away: 6 });
  assert.ok(!r.stats.some((s) => s.label === 'Double'), 'null dilewati');
  assert.equal(r.stats.length, 6);
  assert.deepEqual(parseMlbBoxscore({}).stats, []);
});

test('NHL: right-rail (persen pecahan jadi persen) dan landing (gol per babak, sisi dari singkatan tim)', () => {
  const rail = parseNhlRightRail({ teamGameStats: [
    { category: 'sog', homeValue: 31, awayValue: 24 }, { category: 'faceoffWinningPctg', homeValue: 0.55, awayValue: 0.45 },
    { category: 'powerPlay', homeValue: '1/3', awayValue: '0/2' }, { category: 'unknown', homeValue: 1, awayValue: 2 }, { category: 'hits', homeValue: 'x', awayValue: 2 },
  ] });
  assert.deepEqual(rail.stats.map((s) => [s.label, s.home, s.away, s.unit]), [['Tembakan on goal', 31, 24, undefined], ['Menang faceoff', 55, 45, '%'], ['Power play (berhasil)', 1, 0, undefined]]);
  const land = parseNhlLanding({ homeTeam: { abbrev: 'TOR' }, awayTeam: { abbrev: 'BOS' }, summary: { scoring: [
    { periodDescriptor: { number: 1, periodType: 'REG' }, goals: [{ timeInPeriod: '05:30', teamAbbrev: { default: 'TOR' }, name: { default: 'A. Matthews' } }] },
    { periodDescriptor: { number: 2, periodType: 'REG' }, goals: [{ timeInPeriod: '12:00', teamAbbrev: { default: 'BOS' }, name: { default: 'D. Pastrnak' } }, { timeInPeriod: '13:00', teamAbbrev: { default: 'XXX' }, name: { default: 'Siapa' } }] },
    { periodDescriptor: { number: 4, periodType: 'OT' }, goals: [{ timeInPeriod: '01:10', teamAbbrev: { default: 'TOR' }, name: { default: 'M. Marner' } }] },
  ] } });
  assert.deepEqual(land.events.map((e) => [e.side, e.minute, e.clock, e.player]), [['home', 6, 'B1 05:30', 'A. Matthews'], ['away', 32, 'B2 12:00', 'D. Pastrnak'], ['home', null, 'OT 01:10', 'M. Marner']]);
  assert.deepEqual(parseNhlLanding({}).events, []);
});

/* ------------------------------------------------------------------ penyedia */

const NHL_RAIL = { teamGameStats: [{ category: 'sog', homeValue: 20, awayValue: 18 }] };
const NHL_LAND = { homeTeam: { abbrev: 'TOR' }, awayTeam: { abbrev: 'BOS' }, summary: { scoring: [{ periodDescriptor: { number: 1 }, goals: [{ timeInPeriod: '01:00', teamAbbrev: { default: 'TOR' }, name: { default: 'X' } }] }] } };
const MLB_BOX = { teams: { home: { teamStats: { batting: { hits: 3 } } }, away: { teamStats: { batting: { hits: 2 } } } } };
function net(over = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [re, v] of Object.entries(over)) if (new RegExp(re).test(u)) { if (v instanceof Error) throw v; if (v?.status) return new Response('{}', { status: v.status }); return new Response(JSON.stringify(v)); }
    if (u.includes('site.api.espn.com') && u.includes('/summary?event=')) return new Response(JSON.stringify(SUMMARY));
    if (u.includes('statsapi.mlb.com')) return new Response(JSON.stringify(MLB_BOX));
    if (u.includes('right-rail')) return new Response(JSON.stringify(NHL_RAIL));
    if (u.includes('landing')) return new Response(JSON.stringify(NHL_LAND));
    return new Response('{}', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}
const M = (id, status, extra = {}) => ({ id, status, kickoff: '2026-11-19T10:00:00Z', sport: 'football', ...extra });
const ESPN = M('espn:123', 'finished', { feed: 'soccer/eng.1', espnId: '123' });

test('penyedia statistik: alamat yang benar per sumber; hanya laga live/selesai; id/feed ganjil ditolak', async () => {
  const f = net();
  const p = createStatsProvider({ fetchImpl: f });
  assert.equal(p.supports(M('espn:1', 'upcoming', { feed: 'soccer/eng.1', espnId: '1' })), false);
  assert.equal(p.supports(M('tsdb:1', 'finished')), false);
  assert.equal(p.supports(M('demo:1', 'finished')), false);
  assert.equal(p.supports({ ...ESPN, feed: '../../x' }), false);
  assert.equal(p.supports({ ...ESPN, feed: 'soccer/eng.1?x=1' }), false);
  assert.equal(p.supports({ ...ESPN, espnId: '12/../3', id: 'espn:12/../3' }), false);
  const a = await p.fetchFor(ESPN);
  assert.equal(f.calls[0], 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=123');
  assert.ok(a.stats.length && a.events.length && a.leaders.length);
  const b = await p.fetchFor(M('pub:mlb-777', 'live'));
  assert.equal(f.calls.at(-1), 'https://statsapi.mlb.com/api/v1/game/777/boxscore');
  assert.deepEqual(b.stats, [{ label: 'Hit', home: 3, away: 2 }]);
  const c = await p.fetchFor(M('pub:nhl-888', 'finished'));
  assert.deepEqual(f.calls.slice(-2).sort(), ['https://api-web.nhle.com/v1/gamecenter/888/landing', 'https://api-web.nhle.com/v1/gamecenter/888/right-rail']);
  assert.equal(c.stats.length, 1);
  assert.equal(c.events.length, 1);
  assert.equal(await p.fetchFor(M('pub:ol-5', 'finished')), null, 'OpenLigaDB: gol sudah ikut di data laga, tanpa permintaan');
  assert.equal(f.calls.length, 4);
  assert.deepEqual([p.report.tried, p.report.ok], [3, 3]);
});

test('penyedia statistik: satu panggilan NHL gagal tetap memberi separuh; semua gagal = null dan tercatat; sampah tidak melempar', async () => {
  const half = createStatsProvider({ fetchImpl: net({ 'landing': { status: 500 } }) });
  const r = await half.fetchFor(M('pub:nhl-1', 'finished'));
  assert.equal(r.stats.length, 1);
  assert.equal(r.events.length, 0);
  const dead = createStatsProvider({ fetchImpl: net({ 'site\\.api\\.espn': new Error('ECONNRESET') }) });
  assert.equal(await dead.fetchFor(ESPN), null);
  assert.match(dead.report.failed[0].error, /ECONNRESET/);
  assert.equal(dead.report.bySource.espn.failed, 1);
  const junk = createStatsProvider({ fetchImpl: async () => new Response('<html>') });
  assert.equal(await junk.fetchFor(ESPN), null);
  const empty = createStatsProvider({ fetchImpl: net({ 'summary': {} }) });
  assert.deepEqual(await empty.fetchFor(ESPN), { stats: [], events: [], leaders: [] });
  assert.equal(empty.report.bySource.espn.empty, 1);
});

/* ------------------------------------------------------------------ pengayaan build (cache, batas, kegagalan) */

test('enrichStats: live selalu diambil; selesai disimpan dan dipakai ulang; batas permintaan; gagal memakai salinan lama', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  const cacheFile = path.join(dir, 'stats-cache.json');
  const T = Date.parse('2026-11-19T12:00:00Z');
  const f = net();
  const provider = createStatsProvider({ fetchImpl: f });
  const list = [
    M('espn:1', 'live', { feed: 'soccer/eng.1', espnId: '1' }),
    M('espn:2', 'finished', { feed: 'soccer/eng.1', espnId: '2', kickoff: '2026-11-19T09:00:00Z' }),
    M('espn:3', 'finished', { feed: 'soccer/esp.1', espnId: '3', kickoff: '2026-11-18T09:00:00Z' }),
    M('tsdb:9', 'finished'),
  ];
  const r1 = await enrichStats(list, { provider, cacheFile, now: () => T, max: 2 });
  assert.deepEqual([r1.report.candidates, r1.report.fetched, r1.report.skippedByCap, r1.report.withData], [3, 2, 1, 2]);
  assert.deepEqual([...r1.patches.keys()].sort(), ['espn:1', 'espn:2'], 'live dulu, lalu hasil terbaru; yang ketiga ditunda');
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['espn:2'], 'hanya laga selesai yang disimpan');

  // build berikutnya: live diambil ulang, espn:2 dari cache, espn:3 diambil (kini ada kuota)
  f.calls.length = 0;
  const r2 = await enrichStats(list, { provider: createStatsProvider({ fetchImpl: f }), cacheFile, now: () => T + 600_000, max: 5 });
  assert.deepEqual([r2.report.fromCache, r2.report.fetched], [1, 2]);
  assert.ok(!f.calls.some((u) => u.includes('event=2')), 'laga selesai tidak diminta lagi');
  assert.equal(r2.patches.size, 3);

  // semua mati: live tak punya salinan -> kosong; selesai memakai cache
  const dead = createStatsProvider({ fetchImpl: async () => { throw new Error('mati'); } });
  const r3 = await enrichStats(list, { provider: dead, cacheFile, now: () => T + 1_200_000, max: 5 });
  assert.deepEqual([...r3.patches.keys()].sort(), ['espn:2', 'espn:3']);

  // hasil kosong untuk laga selesai: dicoba lagi hanya setelah 6 jam
  const none = createStatsProvider({ fetchImpl: net({ 'summary': {} }) });
  const only = [M('espn:7', 'finished', { feed: 'soccer/eng.2', espnId: '7' })];
  const f2 = path.join(dir, 'c2.json');
  await enrichStats(only, { provider: none, cacheFile: f2, now: () => T });
  const again1 = await enrichStats(only, { provider: none, cacheFile: f2, now: () => T + 3_600_000 });
  assert.equal(again1.report.fromCache, 1);
  const again2 = await enrichStats(only, { provider: none, cacheFile: f2, now: () => T + 7 * 3_600_000 });
  assert.equal(again2.report.fetched, 1);
});

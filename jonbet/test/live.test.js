// Tes sumber skor langsung (ESPN) untuk mode statis: pencocokan nama, jam per cabang, pemantau, kegagalan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, endpointsFor, nameScore, overlayOf, parseScoreboard, pickEvent, scoreboardUrl, ESPN_ORIGIN } from '../public/js/static/espn.js';
import { createLiveFeed } from '../public/js/static/live.js';
import { analyze, pickOf } from '../server/model/model.js';
import { explain } from '../server/ai/explainer.js';
import { SPORTS_BY_ID, publicSport } from '../server/sports.js';
import { board, espnEvent, fakeEspn } from './fake-espn.js';

const T0 = Date.parse('2026-11-18T14:00:00Z');
const MIN = 60_000;
const PL = `${ESPN_ORIGIN}/apis/site/v2/sports/soccer/eng.1/scoreboard`;
const NBA = `${ESPN_ORIGIN}/apis/site/v2/sports/basketball/nba/scoreboard`;

const mk = (over = {}) => ({
  id: 'tsdb:1', sport: 'football', league: 'English Premier League',
  home: { name: 'Manchester City' }, away: { name: 'Arsenal' },
  kickoff: new Date(T0 - 30 * MIN).toISOString(), status: 'upcoming', minute: null, period: null, progress: null, score: null,
  forecast: { home: 0.5, draw: 0.25, away: 0.25, pick: 'H', pickP: 0.5, confidence: 40, live: false },
  ...over,
});
const emptyForm = (name) => ({ name, matches: [], w: 0, d: 0, l: 0, gf: 0, ga: 0, n: 0 });
const ratings = { home: { rating: 1650, games: 30, gf: 60, ga: 20 }, away: { rating: 1600, games: 30, gf: 50, ga: 25 } };

/* ------------------------------------------------------------------ endpoint */

test('endpointsFor: liga dikenal, tak dikenal, dan cabang yang tak didukung', () => {
  const p = (sport, league) => endpointsFor({ sport, league }).map((e) => e.path);
  assert.deepEqual(p('football', 'English Premier League'), ['soccer/eng.1']);
  assert.deepEqual(p('football', 'Spanish La Liga'), ['soccer/esp.1']);
  assert.deepEqual(p('football', 'Spanish La Liga 2'), ['soccer/esp.2'], 'liga yang lebih spesifik menang');
  assert.deepEqual(p('football', 'German Bundesliga 2'), ['soccer/ger.2']);
  assert.deepEqual(p('football', 'UEFA Europa Conference League'), ['soccer/uefa.europa.conf']);
  assert.deepEqual(p('football', 'UEFA Europa League'), ['soccer/uefa.europa']);
  assert.deepEqual(p('basketball', 'NBA'), ['basketball/nba']);
  assert.deepEqual(p('basketball', "NCAA Women's Basketball"), ['basketball/womens-college-basketball']);
  assert.deepEqual(p('basketball', 'NCAA Division I Basketball'), ['basketball/mens-college-basketball']);
  assert.deepEqual(p('americanfootball', 'NFL'), ['football/nfl']);
  assert.deepEqual(p('baseball', 'MLB'), ['baseball/mlb']);
  assert.deepEqual(p('icehockey', 'NHL'), ['hockey/nhl']);
  assert.deepEqual(p('football', 'Liga Antah Berantah'), ['soccer/all'], 'sepak bola tak dikenal -> cadangan umum');
  assert.deepEqual(p('basketball', 'Liga Basket Antah'), []);
  for (const s of ['tennis', 'badminton', 'esports', 'mma', 'rugby', 'volleyball', 'futsal']) assert.deepEqual(p(s, 'Apa Saja'), [], `${s} tidak didukung`);
  assert.equal(scoreboardUrl(ENDPOINTS[0]), PL);
  // semua URL hanya ke satu asal (CSP connect-src hanya mengizinkan itu)
  for (const e of [...ENDPOINTS, { path: 'soccer/all' }]) assert.equal(new URL(scoreboardUrl(e)).origin, ESPN_ORIGIN);
});

/* ------------------------------------------------------------------ nama tim */

test('nameScore: variasi nama yang wajar cocok, tim berbeda tidak', () => {
  const same = [
    ['Manchester City', 'Man City'], ['Man United', 'Manchester United'], ['Bayern Munich', 'FC Bayern'],
    ['Atletico Madrid', 'Atlético de Madrid'], ['Wolves', 'Wolverhampton Wanderers'], ['Spurs', 'Tottenham Hotspur'],
    ['Inter', 'Internazionale'], ['Inter Milan', 'Inter'], ['PSG', 'Paris Saint-Germain'], ['Los Angeles Lakers', 'Lakers'],
    ['New York Knicks', 'NY Knicks'], ['Borussia Monchengladbach', 'B. Mönchengladbach'], ['1. FC Köln', 'FC Koln'],
    ['Arsenal', 'Arsenal FC'], ['Real Madrid', 'Real Madrid CF'], ['Arsenal Women', 'Arsenal W'], ['Barcelona B', 'Barcelona II'], ['Boston Red Sox', 'Red Sox'],
  ];
  for (const [a, b] of same) assert.ok(nameScore(a, b) >= 0.6, `${a} ~ ${b} = ${nameScore(a, b)}`);
  const diff = [
    ['Manchester City', 'Manchester United'], ['Arsenal', 'Aston Villa'], ['Inter', 'AC Milan'], ['Real Madrid', 'Real Sociedad'],
    ['Los Angeles Rams', 'Los Angeles Chargers'], ['LA Lakers', 'LA Clippers'], ['Chelsea', 'Chelsea Ladies'], ['Arsenal', 'Arsenal Women'], ['Barcelona', 'Barcelona B'], ['Real Madrid', 'Real Madrid II'], ['Ajax', 'Ajax U21'],
    ['', 'Arsenal'], ['Arsenal', ''], ['FC', 'Arsenal'],
  ];
  for (const [a, b] of diff) assert.equal(nameScore(a, b), 0, `${a} !~ ${b}`);
});

test('pickEvent: orientasi terbalik, selisih jam, ambigu, dan dobel-laga', () => {
  const m = mk();
  const k = Date.parse(m.kickoff);
  const e1 = espnEvent({ id: 'a', date: k, home: 'Manchester City', away: 'Arsenal' });
  const pick = (events, match = m) => pickEvent(match, parseScoreboard(board(...events)));
  assert.equal(pick([e1]).ev.id, 'a');
  assert.equal(pick([e1]).swapped, false);
  const sw = espnEvent({ id: 'b', date: k, home: 'Arsenal', away: 'Manchester City' });
  assert.equal(pick([sw]).swapped, true, 'kandang/tandang terbalik terdeteksi');
  assert.equal(pick([espnEvent({ id: 'c', date: k + 9 * 3600_000, home: 'Manchester City', away: 'Arsenal' })]), null, 'terlalu jauh dari jam mulai');
  assert.equal(pick([espnEvent({ id: 'd', date: k, home: 'Chelsea', away: 'Arsenal' })]), null, 'satu tim saja tidak cukup');
  assert.equal(pick([espnEvent({ id: 'e', date: k, home: 'Manchester United', away: 'Arsenal' })]), null);
  // dua peristiwa sama persis pada jam sama: tidak ada yang dipilih
  assert.equal(pick([e1, { ...e1, id: 'dup' }]), null, 'ambigu -> tanpa overlay');
  // dobel-laga baseball: jam terdekat menang
  const bb = mk({ sport: 'baseball', league: 'MLB', home: { name: 'Boston Red Sox' }, away: { name: 'New York Yankees' } });
  const g1 = espnEvent({ id: 'g1', date: k - 4 * 3600_000, home: 'Boston Red Sox', away: 'New York Yankees' });
  const g2 = espnEvent({ id: 'g2', date: k + 10 * 60_000, home: 'Boston Red Sox', away: 'New York Yankees' });
  assert.equal(pick([g1, g2], bb).ev.id, 'g2');
});

test('parseScoreboard: masukan rusak tidak membuat galat', () => {
  for (const bad of [null, undefined, {}, { events: null }, { events: [null, {}, { competitions: [] }, { competitions: [{ competitors: [{}] }] }] }, 'x', 5]) {
    assert.deepEqual(parseScoreboard(bad), []);
  }
  const ok = espnEvent({ date: T0, home: 'A', away: 'B', hs: 'x' });
  assert.equal(parseScoreboard(board(ok))[0].home.score, null, 'skor non-angka -> null');
  const big = espnEvent({ date: T0, home: 'A', away: 'B', hs: 5000 });
  assert.equal(parseScoreboard(board(big))[0].home.score, null, 'skor tidak masuk akal -> null');
  const obj = espnEvent({ date: T0, home: 'A', away: 'B' });
  obj.competitions[0].competitors[0].score = { value: 3, displayValue: '3' };
  assert.equal(parseScoreboard(board(obj))[0].home.score, 3);
});

/* ------------------------------------------------------------------ jam dan status per cabang */

const ov = (match, evOpts, swapped = false) => {
  const [ev] = parseScoreboard(board(espnEvent({ date: Date.parse(match.kickoff), home: 'X', away: 'Y', ...evOpts })));
  return overlayOf(match, ev, swapped);
};

test('overlayOf sepak bola: menit, jeda, tambahan waktu, selesai, ditunda', () => {
  const m = mk();
  const live = ov(m, { hs: 1, as: 0, clock: "67'", period: 2 });
  assert.deepEqual([live.status, live.score, live.minute, live.period], ['live', { home: 1, away: 0 }, 67, 'Babak 2']);
  assert.ok(Math.abs(live.progress - 67 / 90) < 1e-9);
  const stoppage = ov(m, { clock: "90'+4'", period: 2 });
  assert.equal(stoppage.minute, 94);
  assert.ok(stoppage.progress <= 0.99);
  assert.equal(ov(m, { name: 'STATUS_HALFTIME', clock: "45'", period: 1 }).period, 'Turun minum');
  assert.equal(ov(m, { clock: "105'", period: 3, name: 'STATUS_FIRST_HALF_EXTRA_TIME' }).period, 'Perpanjangan');
  assert.equal(ov(m, { name: 'STATUS_SHOOTOUT' }).period, 'Adu penalti');
  const fin = ov(m, { state: 'post', completed: true, name: 'STATUS_FULL_TIME', hs: 2, as: 2 });
  assert.deepEqual([fin.status, fin.period, fin.progress, fin.minute], ['finished', 'Selesai', 1, null]);
  assert.equal(ov(m, { state: 'pre', name: 'STATUS_SCHEDULED' }), null, 'belum mulai: tidak menimpa');
  assert.equal(ov(m, { state: 'post', completed: false, name: 'STATUS_POSTPONED' }), null);
  assert.equal(ov(m, { state: 'in', name: 'STATUS_CANCELED' }), null);
  assert.equal(ov(m, { state: 'post', completed: false, name: 'STATUS_FINAL' }), null, 'post tetapi belum completed');
  // orientasi terbalik menukar skor
  const swapped = ov(m, { hs: 3, as: 1, clock: "10'", period: 1 }, true);
  assert.deepEqual(swapped.score, { home: 1, away: 3 });
});

test('overlayOf basket, football, hoki, baseball: babak, jam, dan progres masuk akal', () => {
  const nba = mk({ sport: 'basketball', league: 'NBA' });
  const q3 = ov(nba, { hs: 80, as: 77, period: 3, clock: '4:12', clockSec: 252 });
  assert.equal(q3.period, 'Q3 4:12');
  assert.ok(Math.abs(q3.progress - (2 + (1 - 252 / 720)) / 4) < 1e-9);
  assert.equal(ov(nba, { period: 5, clock: '2:00', clockSec: 120 }).period, 'OT 2:00');
  assert.equal(ov(nba, { period: 6, clock: '2:00', clockSec: 120 }).period, 'OT2 2:00');
  assert.equal(ov(nba, { name: 'STATUS_HALFTIME', period: 2 }).progress, 0.5);
  assert.equal(ov(nba, { name: 'STATUS_END_PERIOD', period: 1 }).period, 'Akhir Q1');
  const ncaa = mk({ sport: 'basketball', league: "NCAA Men's Basketball" });
  assert.match(ov(ncaa, { period: 2, clock: '10:00', clockSec: 600 }).period, /^H2 /, 'basket kampus pria: dua babak');
  const nfl = mk({ sport: 'americanfootball', league: 'NFL' });
  const f = ov(nfl, { period: 4, clock: '1:30', clockSec: 90 });
  assert.ok(f.progress > 0.95 && f.progress <= 0.99);
  const nhl = mk({ sport: 'icehockey', league: 'NHL' });
  const h = ov(nhl, { period: 2, clock: '10:00', clockSec: 600 });
  assert.equal(h.period, 'P2 10:00');
  assert.equal(h.minute, 30, 'menit permainan: 20 + 10');
  const mlb = mk({ sport: 'baseball', league: 'MLB' });
  assert.equal(ov(mlb, { period: 5, detail: 'Top 5th' }).period, 'Inning 5 (atas)');
  assert.equal(ov(mlb, { period: 5, detail: 'Bot 5th' }).period, 'Inning 5 (bawah)');
  const b = ov(mlb, { period: 12, detail: 'Top 12th' });
  assert.equal(b.progress, 0.99);
  // cabang yang tidak dipetakan -> tidak ada overlay
  assert.equal(ov(mk({ sport: 'tennis', league: 'ATP' }), { period: 1 }), null);
  // seluruh nilai berada pada rentang yang diterima model
  for (const o of [q3, f, h, b]) assert.ok(o.progress >= 0 && o.progress <= 1);
});

/* ------------------------------------------------------------------ pemantau */

function setup({ matches, routes, builtAt = T0 - 2 * MIN, clock = { t: T0 }, ...extra } = {}) {
  const fetchImpl = fakeEspn(routes);
  const snap = { builtAt: new Date(builtAt).toISOString(), matches };
  let changes = 0;
  const bundleCalls = [];
  const feed = createLiveFeed({
    getSnapshot: async () => snap,
    getBundle: async (id) => { bundleCalls.push(id); const m = snap.matches.find((x) => x.id === id); return { match: m, ratings, form: { home: emptyForm('H'), away: emptyForm('A') }, h2h: { matches: [], aWins: 0, bWins: 0, draws: 0 } }; },
    sportOf: (id) => publicSport(SPORTS_BY_ID[id]),
    model: { analyze, pickOf },
    explain,
    fetchImpl,
    now: () => clock.t,
    onChange: () => { changes++; },
    ...extra,
  });
  return { feed, fetchImpl, snap, clock, bundleCalls, changes: () => changes };
}
const live = (m, hs, as, clock = "30'", extra = {}) => espnEvent({ id: 'e1', date: Date.parse(m.kickoff), home: 'Manchester City', away: 'Arsenal', hs, as, clock, period: 1, ...extra });

test('pemantau: laga upcoming di snapshot menjadi live dengan skor, menit, dan peluang yang dihitung ulang', async () => {
  const m = mk();
  const t = setup({ matches: [m], routes: { [PL]: board(live(m, 0, 0)) } });
  const before = await t.feed.tick();
  assert.equal(before.polled, 1);
  const a = t.feed.applyList(t.snap).matches[0];
  assert.deepEqual([a.status, a.score, a.minute, a.period], ['live', { home: 0, away: 0 }, 30, 'Babak 1']);
  assert.equal(a.liveSrc.name, 'ESPN');
  assert.equal(m.status, 'upcoming', 'snapshot asli tidak diubah');
  assert.equal(a.forecast.live, true);
  const p0 = a.forecast.home;

  // gol tuan rumah: peluang tuan rumah naik, tanpa menunggu build
  t.clock.t += 20_000;
  t.fetchImpl.routes[PL] = board(live(m, 2, 0, "31'"));
  await t.feed.tick();
  const b = t.feed.applyList(t.snap).matches[0];
  assert.deepEqual(b.score, { home: 2, away: 0 });
  assert.ok(b.forecast.home > p0 + 0.2, `peluang naik: ${p0} -> ${b.forecast.home}`);
  assert.ok(Math.abs(b.forecast.home + b.forecast.draw + b.forecast.away - 1) < 1e-6);
  assert.ok(t.changes() >= 2, 'tampilan diberi tahu setiap ada perubahan');
  assert.deepEqual(t.bundleCalls, ['tsdb:1'], 'bundel hanya diambil sekali per snapshot');

  // bundel detail: analisis dan ringkasan ikut dihitung ulang
  const bundle = t.feed.applyBundle({ match: m, analysis: { stale: true }, form: { home: emptyForm('H'), away: emptyForm('A') }, h2h: { matches: [], aWins: 0, bWins: 0, draws: 0 }, summary: 'lama', ratings, meta: {} });
  assert.equal(bundle.match.status, 'live');
  assert.equal(bundle.analysis.live !== null, true);
  assert.ok(bundle.analysis.current.probs.home > bundle.analysis.pre.probs.home);
  assert.notEqual(bundle.summary, 'lama');
  assert.equal(JSON.stringify(bundle).includes('undefined'), false);
});

test('pemantau: tidak ada permintaan bila tidak ada laga yang relevan, atau tab tersembunyi/offline', async () => {
  const far = mk({ kickoff: new Date(T0 + 3 * 3600_000).toISOString() });
  const old = mk({ id: 'tsdb:2', kickoff: new Date(T0 - 7 * 3600_000).toISOString() });
  const done = mk({ id: 'tsdb:3', status: 'finished', score: { home: 1, away: 0 } });
  const t = setup({ matches: [far, old, done], routes: {} });
  assert.equal((await t.feed.tick()).polled, 0);
  assert.equal(t.fetchImpl.calls.length, 0);

  let hidden = true;
  const t2 = setup({ matches: [mk()], routes: { [PL]: board() }, visible: () => !hidden });
  assert.deepEqual(await t2.feed.tick(), { skipped: 'hidden' });
  hidden = false;
  assert.equal((await t2.feed.tick()).polled, 1);
  const t3 = setup({ matches: [mk()], routes: {}, online: () => false });
  assert.deepEqual(await t3.feed.tick(), { skipped: 'hidden' });
  assert.equal(t3.fetchImpl.calls.length, 0);

  // laga yang mulai dalam 15 menit dipantau; 25 menit belum
  const soon = setup({ matches: [mk({ kickoff: new Date(T0 + 15 * MIN).toISOString() })], routes: { [PL]: board() } });
  assert.equal((await soon.feed.tick()).polled, 1);
  const notYet = setup({ matches: [mk({ kickoff: new Date(T0 + 25 * MIN).toISOString() })], routes: { [PL]: board() } });
  assert.equal((await notYet.feed.tick()).polled, 0);
});

test('pemantau: laga di liga yang tidak dikenal ESPN tetap memakai snapshot (tanpa overlay, tanpa galat)', async () => {
  const bb = mk({ id: 'tsdb:9', sport: 'basketball', league: 'Liga Basket Antah', status: 'live', score: { home: 10, away: 8 }, minute: null, period: 'Q1' });
  const t = setup({ matches: [bb], routes: {} });
  const r = await t.feed.tick();
  assert.equal(r.polled, 0);
  const out = t.feed.applyList(t.snap);
  assert.equal(out, t.snap, 'tanpa overlay: objek yang sama dikembalikan');
  assert.equal(t.feed.status().state, 'idle');
});

test('pemantau: gangguan ESPN: mundur bertahap, 404 ditunda lama, status "down" lalu pulih', async () => {
  const m = mk();
  const t = setup({ matches: [m], routes: { [PL]: new TypeError('Failed to fetch') } });
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 1);
  t.clock.t += 5_000;
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 1, 'masih dalam masa tunda 20 dtk');
  t.clock.t += 20_000;
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 2);
  t.clock.t += 41_000;
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 3, 'tunda berikutnya 40 dtk');
  assert.equal(t.feed.status().state, 'down');
  assert.equal(t.feed.applyList(t.snap), t.snap, 'gangguan tidak mengubah data');

  // pulih
  t.fetchImpl.routes[PL] = board(live(m, 1, 0));
  t.clock.t += 5 * MIN;
  await t.feed.tick();
  assert.equal(t.feed.status().state, 'live');
  assert.equal(t.feed.applyList(t.snap).matches[0].score.home, 1);

  // 404: liga tidak ada, jangan ditanya selama 15 menit
  const t404 = setup({ matches: [m], routes: { [PL]: { status: 404 } } });
  await t404.feed.tick();
  t404.clock.t += 10 * MIN;
  await t404.feed.tick();
  assert.equal(t404.fetchImpl.calls.length, 1);
  t404.clock.t += 6 * MIN;
  await t404.feed.tick();
  assert.equal(t404.fetchImpl.calls.length, 2);

  // balasan bukan JSON / bentuk aneh
  const junk = setup({ matches: [m], routes: { [PL]: { status: 200 } } });
  junk.fetchImpl.respond = () => new Response('<html>bukan json</html>', { status: 200 });
  await junk.feed.tick();
  assert.equal(junk.feed.applyList(junk.snap), junk.snap);
});

test('pemantau: overlay live kedaluwarsa setelah 3 menit tanpa pembaruan; selesai tidak menimpa snapshot yang sudah selesai', async () => {
  const m = mk({ status: 'live', score: { home: 0, away: 0 }, period: 'Babak 1', minute: 20 });
  const t = setup({ matches: [m], routes: { [PL]: board(live(m, 1, 0, "21'")) } });
  await t.feed.tick();
  assert.equal(t.feed.applyList(t.snap).matches[0].score.home, 1);
  t.clock.t += 2 * MIN;
  assert.equal(t.feed.applyList(t.snap).matches[0].score.home, 1, 'masih berlaku');
  t.clock.t += 61_000;
  assert.equal(t.feed.applyList(t.snap), t.snap, 'kedaluwarsa -> kembali ke snapshot');
  assert.equal(t.feed.status().state, 'idle');

  // ESPN bilang selesai: laga ditandai selesai di browser dan tidak ditanya lagi
  const t2 = setup({ matches: [m], routes: { [PL]: board(live(m, 2, 1, '', { state: 'post', completed: true, name: 'STATUS_FULL_TIME' })) } });
  await t2.feed.tick();
  const f = t2.feed.applyList(t2.snap).matches[0];
  assert.deepEqual([f.status, f.score], ['finished', { home: 2, away: 1 }]);
  t2.clock.t += 60_000;
  await t2.feed.tick();
  assert.equal(t2.fetchImpl.calls.length, 1, 'laga selesai tidak ditanya lagi');

  // snapshot baru sudah memuat hasil akhir: snapshot (sumber resmi) yang dipakai
  const finalSnap = { ...t2.snap, matches: [{ ...m, status: 'finished', score: { home: 2, away: 1 } }] };
  assert.equal(t2.feed.applyList(finalSnap), finalSnap);
});

test('pemantau: ambigu atau tim berbeda tidak pernah menimpa laga yang salah', async () => {
  const m = mk();
  const k = Date.parse(m.kickoff);
  const other = espnEvent({ id: 'x', date: k, home: 'Chelsea', away: 'Liverpool', hs: 5, as: 5, clock: "50'", period: 2 });
  const t = setup({ matches: [m], routes: { [PL]: board(other) } });
  await t.feed.tick();
  assert.equal(t.feed.applyList(t.snap), t.snap);
  const dup = live(m, 1, 1);
  const t2 = setup({ matches: [m], routes: { [PL]: board(dup, { ...dup, id: 'dup' }) } });
  await t2.feed.tick();
  assert.equal(t2.feed.applyList(t2.snap), t2.snap);
});

test('pemantau: banyak liga sekaligus dibatasi dan digilir; satu putaran = satu permintaan per liga', async () => {
  const leagues = ['English Premier League', 'Spanish La Liga', 'German Bundesliga', 'Italian Serie A', 'French Ligue 1', 'Dutch Eredivisie', 'Scottish Premiership', 'Turkish Super Lig'];
  const matches = leagues.map((l, i) => mk({ id: `tsdb:${i + 10}`, league: l, status: 'live', score: { home: 0, away: 0 }, minute: 10, period: 'Babak 1' }));
  const t = setup({ matches, routes: {}, maxEndpoints: 3 });
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 3);
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 6);
  const urls = t.fetchImpl.calls.map((c) => c.url);
  assert.equal(new Set(urls).size, 6, 'liga yang belum ditanya didahulukan');
  for (const c of t.fetchImpl.calls) {
    assert.equal(c.init.cache, 'no-store');
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.referrerPolicy, 'no-referrer');
    assert.equal(c.init.headers, undefined, 'tanpa header khusus supaya tidak memicu preflight CORS');
  }
});

test('pemantau: dua laga di liga yang sama dengan satu permintaan', async () => {
  const a = mk();
  const b = mk({ id: 'tsdb:2', home: { name: 'Chelsea' }, away: { name: 'Liverpool' } });
  const t = setup({ matches: [a, b], routes: { [PL]: board(live(a, 1, 0), espnEvent({ id: 'e2', date: Date.parse(b.kickoff), home: 'Chelsea', away: 'Liverpool', hs: 0, as: 3, clock: "60'", period: 2 })) } });
  await t.feed.tick();
  assert.equal(t.fetchImpl.calls.length, 1);
  const out = t.feed.applyList(t.snap).matches;
  assert.deepEqual(out.map((x) => [x.score.home, x.score.away]), [[1, 0], [0, 3]]);
  assert.ok(out[1].forecast.away > out[1].forecast.home);
});

test('pemantau: basket NBA end-to-end dan penjadwal berhenti', async () => {
  const nba = mk({ id: 'tsdb:20', sport: 'basketball', league: 'NBA', home: { name: 'Los Angeles Lakers' }, away: { name: 'Boston Celtics' } });
  const ev = espnEvent({ id: 'n1', date: Date.parse(nba.kickoff), home: 'Los Angeles Lakers', away: 'Boston Celtics', hs: 70, as: 64, period: 3, clock: '8:00', clockSec: 480 });
  const t = setup({ matches: [nba], routes: { [NBA]: board(ev) } });
  await t.feed.tick();
  const o = t.feed.applyList(t.snap).matches[0];
  assert.deepEqual([o.status, o.period, o.score], ['live', 'Q3 8:00', { home: 70, away: 64 }]);
  assert.equal(o.forecast.live, true);
  assert.equal(o.forecast.draw === 0 || o.forecast.draw === undefined || Number.isFinite(o.forecast.draw), true);
  t.feed.start();
  t.feed.stop();
});

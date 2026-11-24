// Tes sumber data nyata ESPN (sisi build/server), penggabungan dengan TheSportsDB, dan build "auto".
// Semua memakai respons tiruan yang mengikuti bentuk JSON publik ESPN: tidak ada akses ke ESPN sungguhan di sini.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEspnProvider, toMatch, statusOf, rangeUrl } from '../server/providers/espn.js';
import { createCompositeProvider, mergeMatches } from '../server/providers/composite.js';
import { createHistory } from '../server/history.js';
import { openDb } from '../server/db.js';
import { ENDPOINTS, endpointsFor, parseScoreboard, pickEvent, leagueNameOf } from '../public/js/static/espn.js';
import { MATCH_ID_RE, matchFile } from '../public/js/static/paths.js';
import { buildPages } from '../scripts/build-pages.mjs';
import { fakeTsdb } from './fake-tsdb.js';
import { board, espnEvent, fakeEspnSite, routeFetch, routeFetch3, LEAGUE_FIXTURES } from './fake-espn.js';

const T0 = Date.parse('2026-11-18T05:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const quiet = () => {};
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `jb-espn-${n}-`));
const readJ = (dir, ...p) => JSON.parse(fs.readFileSync(path.join(dir, ...p), 'utf8'));
const ep = (p) => ENDPOINTS.find((e) => e.path === p);
const one = (e, path = 'soccer/eng.1', name = 'English Premier League') => toMatch(parseScoreboard(board(e))[0], ep(path), name);

/* ------------------------------------------------------------------ pembacaan peristiwa */

test('toMatch: belum mulai -> upcoming dengan id, jalur liga, dan id ESPN yang pasti', () => {
  const m = one(espnEvent({ id: '401', date: T0 + 3 * HOUR, home: 'Manchester City', away: 'Arsenal', hs: 0, as: 0, state: 'pre', name: 'STATUS_SCHEDULED', venue: 'Etihad Stadium' }));
  assert.equal(m.id, 'espn:401');
  assert.equal(m.espnId, '401');
  assert.equal(m.feed, 'soccer/eng.1');
  assert.equal(m.source, 'espn');
  assert.equal(m.sport, 'football');
  assert.equal(m.league, 'English Premier League');
  assert.equal(m.status, 'upcoming');
  assert.equal(m.score, null);
  assert.equal(m.kickoff, new Date(T0 + 3 * HOUR).toISOString());
  assert.deepEqual([m.home.name, m.home.short, m.home.badge], ['Manchester City', 'MAN', null], 'tanpa logo: tidak ada permintaan gambar ke pihak lain');
  assert.equal(m.away.name, 'Arsenal');
  assert.equal(m.venue, 'Etihad Stadium');
});

test('toMatch: live sepak bola, selesai, basket live, ditunda/dibatalkan, dan data rusak', () => {
  const live = one(espnEvent({ id: '1', date: T0 - HOUR, home: 'A United', away: 'B City', hs: 2, as: 1, state: 'in', period: 2, clock: "63'" }));
  assert.equal(live.status, 'live');
  assert.deepEqual(live.score, { home: 2, away: 1 });
  assert.equal(live.minute, 63);
  assert.equal(live.period, 'Babak 2');
  assert.ok(live.progress > 0.65 && live.progress < 0.75);

  const fin = one(espnEvent({ id: '2', date: T0 - 4 * HOUR, home: 'A United', away: 'B City', hs: 3, as: 0, state: 'post', name: 'STATUS_FULL_TIME', completed: true }));
  assert.equal(fin.status, 'finished');
  assert.deepEqual(fin.score, { home: 3, away: 0 });
  assert.equal(fin.period, 'Selesai');
  assert.equal(fin.progress, 1);

  const nba = one(espnEvent({ id: '3', date: T0 - 90 * 60_000, home: 'Los Angeles Lakers', away: 'Boston Celtics', hs: 61, as: 55, state: 'in', period: 3, clock: '6:00', clockSec: 360 }), 'basketball/nba', 'National Basketball Association');
  assert.equal(nba.status, 'live');
  assert.equal(nba.period, 'Q3 6:00');
  assert.ok(Math.abs(nba.progress - 0.625) < 0.01);

  assert.equal(one(espnEvent({ id: '4', date: T0, home: 'A', away: 'B', state: 'pre', name: 'STATUS_POSTPONED' })).status, 'postponed');
  assert.equal(one(espnEvent({ id: '5', date: T0, home: 'A', away: 'B', state: 'pre', name: 'STATUS_CANCELED' })).status, 'cancelled');

  // hasil tanpa skor, id aneh, status tak dikenal: dilewati, bukan dipaksakan
  const noScore = espnEvent({ id: '6', date: T0 - 4 * HOUR, home: 'A', away: 'B', state: 'post', name: 'STATUS_FINAL', completed: true });
  noScore.competitions[0].competitors.forEach((c) => { delete c.score; });
  assert.equal(one(noScore), null);
  assert.equal(one(espnEvent({ id: 'a/b', date: T0, home: 'A', away: 'B', state: 'pre' })), null);
  assert.equal(one(espnEvent({ id: '7', date: T0, home: 'A', away: 'B', state: 'zzz' })), null);
  assert.equal(statusOf({ name: '', state: 'pre', completed: false, home: { score: null }, away: { score: null } }), 'upcoming');
});

test('leagueNameOf dan bentuk respons yang tidak dikenal tidak menimbulkan galat', () => {
  assert.equal(leagueNameOf({ leagues: [{ name: ' English Premier League ' }] }), 'English Premier League');
  for (const j of [null, undefined, {}, { leagues: [] }, { leagues: [{ name: 5 }] }, 'x', []]) assert.equal(leagueNameOf(j), '');
  assert.deepEqual(parseScoreboard({ events: 'bukan daftar' }), []);
});

/* ------------------------------------------------------------------ provider */

const WINDOW = { from: T0 - 2 * DAY, to: T0 + 5 * DAY };

test('provider ESPN: satu permintaan rentang tanggal per liga, laga lengkap tanpa batas kecil', async () => {
  const site = fakeEspnSite({ now: T0 });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0 });
  const rows = await p.listMatches({ ...WINDOW, sports: null });
  assert.equal(site.log.length, ENDPOINTS.length, 'tepat satu permintaan per liga');
  assert.equal(site.log[0], 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20261115-20261124&limit=1000');
  assert.equal(rangeUrl(ep('basketball/nba'), WINDOW.from - DAY, WINDOW.to + DAY), 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261115-20261124&limit=1000');
  // 6 liga contoh x 4 laga/hari x 7 hari (jendela -2 hari .. +5 hari, kickoff 03/08/13/18 UTC)
  assert.ok(rows.length >= 6 * 4 * 6 && rows.length <= 6 * 4 * 8, `jumlah laga: ${rows.length}`);
  assert.equal(new Set(rows.map((m) => m.id)).size, rows.length, 'id unik');
  for (const m of rows) {
    const k = Date.parse(m.kickoff);
    assert.ok(k >= WINDOW.from && k <= WINDOW.to, 'hanya laga dalam jendela');
    assert.match(m.id, /^espn:\d+$/);
    assert.ok(MATCH_ID_RE.test(m.id) && matchFile(m.id), 'id sah untuk berkas data');
  }
  const status = (s) => rows.filter((m) => m.status === s).length;
  assert.ok(status('finished') > 20 && status('upcoming') > 20 && status('live') >= 1, `status ${status('finished')}/${status('upcoming')}/${status('live')}`);
  // nama liga dari respons, bukan tebakan
  assert.deepEqual([...new Set(rows.map((m) => m.league))].sort(), Object.values(LEAGUE_FIXTURES).map((l) => l.name).sort());
  assert.deepEqual([...new Set(rows.map((m) => m.sport))].sort(), ['baseball', 'basketball', 'football', 'icehockey']);
  assert.equal(p.report.ok, ENDPOINTS.length);
  assert.equal(p.report.failed.length, 0);
});

test('provider ESPN: rentang tanggal diabaikan oleh ESPN -> terdeteksi dan diambil per hari (rentang pendek)', async () => {
  const site = fakeEspnSite({ now: T0, singleDayOnly: true });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0, leagues: [ep('soccer/eng.1')] });
  const rows = await p.listMatches({ ...WINDOW, sports: null });
  assert.equal(p.report.rangeSuspect, 1, 'terdeteksi satu liga yang mengabaikan rentang');
  assert.equal(site.log.length, 1 + 10, 'satu permintaan rentang + satu per hari (10 hari dengan margin)');
  assert.ok(site.log.slice(1).every((u) => /dates=\d{8}$/.test(u)), 'permintaan per hari memakai satu tanggal');
  const days = new Set(rows.map((m) => m.kickoff.slice(0, 10)));
  assert.ok(days.size >= 6, `laga tersebar di beberapa hari: ${days.size}`);
  assert.equal(new Set(rows.map((m) => m.id)).size, rows.length);
  for (const m of rows) { const k = Date.parse(m.kickoff); assert.ok(k >= WINDOW.from && k <= WINDOW.to); }
});

test('provider ESPN: rentang normal tidak memicu cadangan per hari; rentang riwayat panjang tidak dipecah', async () => {
  const ok = fakeEspnSite({ now: T0 });
  const p = createEspnProvider({ fetchImpl: ok.impl, now: () => T0, leagues: [ep('soccer/eng.1')] });
  await p.listMatches({ ...WINDOW, sports: null });
  assert.equal(p.report.rangeSuspect, 0);
  assert.equal(ok.log.length, 1);

  const bad = fakeEspnSite({ now: T0, singleDayOnly: true });
  const q = createEspnProvider({ fetchImpl: bad.impl, now: () => T0, leagues: [ep('soccer/eng.1')] });
  await q.listMatches({ from: T0 - 15 * DAY, to: T0, sports: null });
  assert.equal(q.report.rangeSuspect, 1);
  assert.equal(bad.log.length, 1, 'rentang 17 hari: tidak dipecah (batas jumlah permintaan)');
});

test('provider ESPN: HTTP 400 pada rentang+limit -> beralih sendiri ke rentang tanpa limit (hemat permintaan)', async () => {
  const site = fakeEspnSite({ now: T0, rejectLimit: true });
  const logs = [];
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0, log: (m) => logs.push(m) });
  const rows = await p.listMatches({ ...WINDOW, sports: null });
  assert.equal(p.report.mode, 'range-nolimit');
  assert.equal(p.report.failed.length, 0, 'semua liga akhirnya berhasil');
  assert.ok(rows.length >= 6 * 4 * 6, `laga lengkap: ${rows.length}`);
  assert.ok(site.log.some((u) => /dates=\d{8}-\d{8}$/.test(u)), 'memakai rentang tanpa limit');
  assert.ok(!site.log.some((u) => /dates=\d{8}&/.test(u)), 'tidak jatuh ke per hari');
  assert.ok(logs.some((m) => /beralih ke mode "range-nolimit"/.test(m)));
});

test('provider ESPN: semua rentang ditolak -> mode per hari, laga tetap lengkap dan tanpa duplikat', async () => {
  const site = fakeEspnSite({ now: T0, rejectRange: true });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0, concurrency: 1 });
  const rows = await p.listMatches({ ...WINDOW, sports: null });
  assert.equal(p.report.mode, 'days');
  assert.equal(p.report.failed.length, 0);
  assert.ok(rows.length >= 6 * 4 * 6 && rows.length <= 6 * 4 * 8, `jumlah laga: ${rows.length}`);
  assert.equal(new Set(rows.map((m) => m.id)).size, rows.length);
  assert.ok(site.log.filter((u) => /dates=\d{8}$/.test(u)).length >= ENDPOINTS.length * 8, 'satu permintaan per hari per liga');
  // setelah mode global naik, liga berikutnya tidak lagi mencoba rentang: jumlah permintaan rentang terbatas
  assert.ok(site.log.filter((u) => /dates=\d{8}-\d{8}/.test(u)).length <= 3 * 2 + 2, `permintaan rentang yang sia-sia: ${site.log.filter((u) => /dates=\d{8}-\d{8}/.test(u)).length}`);
});

test('provider ESPN: satu liga 400 (slug salah) tidak memaksa semua liga ke mode boros', async () => {
  const bad = ENDPOINTS[0].path;
  const site = fakeEspnSite({ now: T0, badRequestPaths: [bad] });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0, concurrency: 1 });
  await p.listMatches({ ...WINDOW, sports: null });
  assert.equal(p.report.mode, 'range', 'mode global tetap rentang');
  assert.deepEqual(p.report.failed.map((f) => f.path), [bad]);
  assert.ok(!site.log.slice(3).some((u) => /dates=\d{8}$/.test(u)), 'liga lain tidak diminta per hari');
});

test('provider ESPN: filter cabang hanya memanggil liga cabang itu', async () => {
  const site = fakeEspnSite({ now: T0 });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0 });
  const rows = await p.listMatches({ ...WINDOW, sports: ['basketball'] });
  assert.ok(site.log.length > 0 && site.log.every((u) => /\/basketball\//.test(u)), site.log.join('\n'));
  assert.ok(rows.length > 0 && rows.every((m) => m.sport === 'basketball'));
  const before = site.log.length;
  assert.deepEqual(await p.listMatches({ ...WINDOW, sports: ['badminton'] }), [], 'cabang yang tak dicakup: daftar kosong tanpa galat dan tanpa permintaan');
  assert.equal(site.log.length, before);
});

test('provider ESPN: satu liga gagal tidak menggagalkan yang lain, dan tercatat di laporan', async () => {
  const logs = [];
  const site = fakeEspnSite({ now: T0, failPaths: ['soccer/eng.1', 'basketball/nba'] });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0, log: (m) => logs.push(m) });
  const rows = await p.listMatches({ ...WINDOW, sports: null });
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((m) => m.feed === 'soccer/eng.1' || m.feed === 'basketball/nba'));
  assert.ok(rows.some((m) => m.feed === 'soccer/esp.1'));
  assert.deepEqual(p.report.failed.map((f) => f.path).sort(), ['basketball/nba', 'soccer/eng.1']);
  assert.equal(p.report.ok, ENDPOINTS.length - 2);
  assert.match(logs.join('\n'), /2 liga gagal.*soccer\/eng\.1/);
});

test('provider ESPN: sumber mati total -> galat jelas dan berhenti cepat (tidak menunggu puluhan liga)', async () => {
  const site = fakeEspnSite({ now: T0, failAll: true });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0 });
  await assert.rejects(() => p.listMatches({ ...WINDOW, sports: null }), /ESPN tidak merespons/);
  assert.ok(site.log.length <= 8 + 4, `berhenti setelah gagal beruntun: ${site.log.length} dari ${ENDPOINTS.length} permintaan`);
  assert.equal(p.report.aborted, true);
  // respons sampah (bukan JSON) dihitung gagal, bukan membuat proses mati
  const junk = createEspnProvider({ fetchImpl: async () => new Response('<html>bukan json</html>', { status: 200 }), now: () => T0 });
  await assert.rejects(() => junk.listMatches({ ...WINDOW, sports: ['basketball'] }), /ESPN tidak merespons/);
});

test('provider ESPN: getMatch memuat ulang laga yang pernah dilihat; id asing -> null', async () => {
  const site = fakeEspnSite({ now: T0 });
  const p = createEspnProvider({ fetchImpl: site.impl, now: () => T0 });
  const rows = await p.listMatches({ ...WINDOW, sports: ['football'] });
  const up = rows.find((m) => m.status === 'upcoming');
  const before = site.log.length;
  const m = await p.getMatch(up.id);
  assert.equal(m.id, up.id);
  assert.equal(site.log.length, before + 1, 'satu permintaan ke liga laga itu');
  assert.match(site.log.at(-1), new RegExp(`/${up.feed}/scoreboard`));
  assert.equal(await p.getMatch('espn:99999999'), null);
  assert.equal(await p.getMatch('espn:../../etc'), null);
  assert.equal(await p.getMatch('tsdb:123'), null);
});

/* ------------------------------------------------------------------ penggabungan */

const mk = (id, sport, home, away, kickoff, extra = {}) => ({ id, sport, league: 'L', home: { name: home }, away: { name: away }, kickoff: new Date(kickoff).toISOString(), status: 'upcoming', score: null, ...extra });

test('mergeMatches: laga yang sama dari dua sumber tampil sekali (versi sumber utama); yang berbeda tetap ada', () => {
  const main = [mk('espn:1', 'football', 'Manchester City', 'Arsenal', T0 + 3 * HOUR)];
  const extra = [
    mk('tsdb:1', 'football', 'Man City', 'Arsenal FC', T0 + 4 * HOUR), // sama, penulisan nama berbeda
    mk('tsdb:2', 'football', 'Arsenal', 'Manchester City', T0 + 2 * HOUR), // sama, kandang/tandang terbalik
    mk('tsdb:3', 'football', 'Manchester City', 'Arsenal', T0 + 9 * HOUR), // 6 jam kemudian: laga lain
    mk('tsdb:4', 'football', 'Persija Jakarta', 'Persib Bandung', T0 + 3 * HOUR), // liga lain
    mk('tsdb:5', 'tennis', 'Manchester City', 'Arsenal', T0 + 3 * HOUR), // cabang lain
    mk('tsdb:6', 'football', 'Manchester City Women', 'Arsenal Women', T0 + 3 * HOUR), // tim putri, bukan tim yang sama
  ];
  const out = mergeMatches(main, extra);
  assert.deepEqual(out.map((m) => m.id), ['espn:1', 'tsdb:3', 'tsdb:4', 'tsdb:5', 'tsdb:6']);
});

const stub = (name, impl) => ({ name, isDemo: false, premium: false, listMatches: impl, getMatch: async (id) => ({ id, from: name }) });

test('provider gabungan: satu sumber gagal -> yang lain dipakai; keduanya gagal -> galat; getMatch sesuai awalan id', async () => {
  const logs = [];
  const A = [mk('espn:1', 'football', 'Real Madrid', 'Barcelona', T0)];
  const B = [mk('tsdb:1', 'football', 'Real Madrid', 'FC Barcelona', T0 + HOUR), mk('tsdb:2', 'tennis', 'X Y', 'Z W', T0)];
  const ok = (rows) => async () => rows;
  const bad = (msg) => async () => { throw new Error(msg); };
  const log = (m) => logs.push(m);

  const both = createCompositeProvider({ primary: stub('espn', ok(A)), secondary: stub('thesportsdb', ok(B)), log });
  assert.deepEqual((await both.listMatches({})).map((m) => m.id), ['espn:1', 'tsdb:2']);
  assert.equal(both.name, 'espn+thesportsdb');
  assert.equal(both.isDemo, false);
  assert.deepEqual([both.report.espn.ok, both.report.thesportsdb.ok], [true, true]);

  const onlyB = createCompositeProvider({ primary: stub('espn', bad('espn mati')), secondary: stub('thesportsdb', ok(B)), log });
  assert.deepEqual((await onlyB.listMatches({})).map((m) => m.id), ['tsdb:1', 'tsdb:2']);
  assert.equal(onlyB.report.espn.ok, false);
  const onlyA = createCompositeProvider({ primary: stub('espn', ok(A)), secondary: stub('thesportsdb', bad('tsdb mati')), log });
  assert.deepEqual((await onlyA.listMatches({})).map((m) => m.id), ['espn:1']);
  assert.match(logs.join('\n'), /espn gagal, memakai thesportsdb saja: espn mati/);
  assert.match(logs.join('\n'), /thesportsdb gagal, memakai espn saja: tsdb mati/);

  const none = createCompositeProvider({ primary: stub('espn', bad('espn mati')), secondary: stub('thesportsdb', bad('tsdb mati')), log });
  await assert.rejects(() => none.listMatches({}), /espn mati/);

  assert.deepEqual(await both.getMatch('espn:9'), { id: 'espn:9', from: 'espn' });
  assert.deepEqual(await both.getMatch('tsdb:9'), { id: 'tsdb:9', from: 'thesportsdb' });
});

/* ------------------------------------------------------------------ rating dan id */

test('riwayat: laga yang sama dari dua sumber (id berbeda) tidak dihitung dua kali oleh Elo', () => {
  const db = openDb(':memory:');
  const h = createHistory(db, { now: () => T0 });
  const fin = (id, home, away, k, hs = 2, as = 1) => mk(id, 'football', home, away, k, { status: 'finished', score: { home: hs, away: as } });
  assert.equal(h.ingestResult(fin('espn:1', 'Manchester City', 'Arsenal', T0 - 3 * DAY)), true);
  assert.equal(h.ingestResult(fin('tsdb:9', 'Manchester City', 'Arsenal', T0 - 3 * DAY + HOUR)), false, 'laga yang sama dari sumber lain');
  assert.equal(h.ingestResult(fin('tsdb:8', 'Arsenal', 'Manchester City', T0 - 3 * DAY, 1, 2)), false, 'kandang/tandang terbalik');
  assert.equal(h.statsFor('football', 'Manchester City').games, 1);
  // pertemuan lain di hari berbeda tetap dihitung
  assert.equal(h.ingestResult(fin('espn:2', 'Manchester City', 'Arsenal', T0 - DAY)), true);
  assert.equal(h.statsFor('football', 'Manchester City').games, 2);
  db.close();
});

test('id ESPN sah untuk nama berkas; id berbahaya ditolak', () => {
  assert.ok(MATCH_ID_RE.test('espn:401547652'));
  assert.equal(matchFile('espn:401547652'), 'm/espn_401547652.json');
  for (const bad of ['espn:', 'espn:../x', 'espn:a b', 'espn:' + 'a'.repeat(49), 'esp:1', 'ESPN:1', 'espn:1/2']) assert.equal(MATCH_ID_RE.test(bad), false, bad);
});

/* ------------------------------------------------------------------ browser: skor langsung untuk laga ESPN */

test('browser: laga ESPN memakai jalur liga dan id yang pasti, bukan tebakan nama', () => {
  const m = { sport: 'football', league: 'Nama Liga Yang Tidak Dikenal', feed: 'soccer/eng.1', espnId: '401', home: { name: 'Manchester City' }, away: { name: 'Arsenal' }, kickoff: new Date(T0).toISOString() };
  assert.deepEqual(endpointsFor(m).map((e) => e.path), ['soccer/eng.1']);
  // jalur di luar tabel tetap bisa (ESPN menambah liga) selama bentuknya wajar; yang aneh ditolak (jatuh ke tebakan nama)
  assert.deepEqual(endpointsFor({ ...m, feed: 'soccer/por.2' }).map((e) => e.path), ['soccer/por.2']);
  assert.notDeepEqual(endpointsFor({ ...m, feed: '../../x' }).map((e) => e.path), ['../../x']);
  assert.notDeepEqual(endpointsFor({ ...m, feed: 'soccer/eng.1?x=1' }).map((e) => e.path), ['soccer/eng.1?x=1']);

  // id dipakai langsung walau nama berbeda jauh
  const evs = parseScoreboard(board(
    espnEvent({ id: '401', date: T0, home: 'Man. City FC (nama lain)', away: 'The Gunners', hs: 1, as: 0 }),
    espnEvent({ id: '402', date: T0, home: 'Manchester City', away: 'Arsenal', hs: 9, as: 9 }),
  ));
  assert.equal(pickEvent(m, evs).ev.id, '401');
  // id tidak ada di papan skor: kembali ke pencocokan nama, tidak berhenti
  assert.equal(pickEvent({ ...m, espnId: '999' }, evs).ev.id, '402');
});

/* ------------------------------------------------------------------ build mode "auto" */

const buildOpts = (out, state, over = {}) => ({ outDir: path.join(out, 'dist'), stateDir: state, provider: 'auto', now: () => T0, gapMs: 0, retryDelayMs: 0, log: quiet, ...over });

test('build auto: ESPN utama + TheSportsDB pelengkap; liga dan tim nyata, riwayat dan rating dari hasil ESPN', async () => {
  const out = tmp('auto'); const state = tmp('autostate');
  const espn = fakeEspnSite({ now: T0 });
  const tsdb = fakeTsdb({ now: T0 });
  const logs = [];
  const r = await buildPages(buildOpts(out, state, { fetchImpl: routeFetch(espn, tsdb), log: (...a) => logs.push(a.join(' ')) }));
  assert.equal(r.outcome, 'fresh');
  const cfg = readJ(r.outDir, 'data/config.json');
  assert.equal(cfg.demo, false);
  assert.equal(cfg.provider, 'auto');
  const snap = readJ(r.outDir, 'data/matches.json');
  const espnM = snap.matches.filter((m) => m.id.startsWith('espn:'));
  const tsdbM = snap.matches.filter((m) => m.id.startsWith('tsdb:'));
  assert.ok(espnM.length > 100 && tsdbM.length > 20, `espn ${espnM.length}, tsdb ${tsdbM.length}`);
  assert.equal(new Set(snap.matches.map((m) => m.id)).size, snap.matches.length);
  assert.ok(espnM.every((m) => m.source === 'espn' && LEAGUE_FIXTURES[m.feed]?.name === m.league && m.espnId === m.id.slice(5)));
  assert.ok(espnM.some((m) => m.league === 'English Premier League' && m.home.name === 'Manchester City' || m.away.name === 'Manchester City'), 'tim dan liga sungguhan dari ESPN');
  assert.ok(!espnM.some((m) => /^Liga /.test(m.league)), 'tidak ada liga rekaan di data ESPN');
  assert.match(logs.join('\n'), /ESPN: \d+ dari \d+ liga merespons/);

  // sumber tercatat di meta.json (bisa dibuka di situs untuk diagnosis)
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.equal(meta.sources.mode, 'auto');
  assert.equal(meta.sources.espn.ok, ENDPOINTS.length);
  assert.equal(meta.sources.espn.leagues, ENDPOINTS.length);
  assert.deepEqual(meta.sources.espn.failed, []);
  assert.ok(meta.sources.espn.events > 100);

  // riwayat 60 hari dari ESPN terisi dalam sedikit permintaan; TheSportsDB hanya untuk cabang yang tidak dicakup ESPN
  assert.equal(readJ(state, 'backfill-espn.json').next, 0);
  const oldTsdb = tsdb.log.filter((u) => /eventsday\.php\?d=(\d{4}-\d{2}-\d{2})/.test(u) && /d=2026-11-(0|10|11|12)\d?&/.test(u));
  assert.ok(oldTsdb.length > 0 && oldTsdb.every((u) => !/s=(Soccer|Basketball|Baseball|Ice(%20| )Hockey|American)/.test(u)), 'riwayat TheSportsDB hanya cabang di luar ESPN');

  // rating dan form berasal dari hasil ESPN
  const up = espnM.find((m) => m.status === 'upcoming');
  const b = readJ(r.outDir, 'data', matchFile(up.id));
  assert.ok(b.ratings.home.games > 3 && b.form.home.n > 0, `rating dari riwayat ESPN: ${b.ratings.home.games}`);
  assert.equal(b.meta.demo, false);
  assert.equal(b.match.feed, up.feed);
  const res = readJ(r.outDir, 'data/results.json');
  assert.ok(Object.keys(res.finished).some((id) => id.startsWith('espn:')), 'hasil ESPN dikirim untuk penilaian tebakan');
  assert.ok(readJ(r.outDir, 'data/record.json').all.backtest.n > 50, 'rekam jejak uji-mundur dari hasil nyata');

  // build kedua: hasil yang sama tidak dihitung dua kali, dan permintaan ESPN hanya jendela biasa (riwayat sudah terisi)
  const boards = () => espn.log.filter((u) => u.includes('/scoreboard?')).length; // permintaan statistik (/summary) dihitung terpisah
  const calls1 = boards();
  const games1 = b.ratings.home.games;
  const r2 = await buildPages(buildOpts(tmp('auto2'), state, { fetchImpl: routeFetch(espn, tsdb), now: () => T0 + 600_000 }));
  assert.equal(r2.outcome, 'fresh');
  // liga tanpa laga (balasan kosong, 36 dari 42) di-cache beberapa jam: hanya liga yang berisi yang ditanya lagi
  assert.equal(boards() - calls1, Object.keys(LEAGUE_FIXTURES).length, 'build berikutnya: hanya liga yang punya laga');
  const b2 = readJ(r2.outDir, 'data', matchFile(up.id));
  assert.equal(b2.ratings.home.games, games1);
});

test('build auto: ESPN menolak rentang tanggal (HTTP 400 seperti di GitHub) -> tetap data nyata lewat mode per hari, tercatat di meta.json', async () => {
  const state = tmp('b400s');
  const espn = fakeEspnSite({ now: T0, rejectRange: true });
  const r = await buildPages(buildOpts(tmp('b400'), state, { fetchImpl: routeFetch(espn, fakeTsdb({ now: T0 })) }));
  assert.equal(r.outcome, 'fresh');
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.equal(meta.demo, false);
  assert.equal(meta.sources.espn.mode, 'days');
  assert.ok(meta.sources.espn.ok >= 6 && meta.sources.espn.events > 100, `ESPN ok=${meta.sources.espn.ok} laga=${meta.sources.espn.events}`);
  const up = readJ(r.outDir, 'data/matches.json').matches.find((m) => m.source === 'espn');
  assert.ok(up, 'ada laga dari ESPN');
  assert.ok(readJ(r.outDir, 'data/record.json'), 'rekam jejak ada');
  // build kedua: hari lampau/jauh dan balasan kosong dipakai dari cache disk, bukan ditanya ulang
  const before = espn.log.length;
  await buildPages(buildOpts(tmp('b400b'), state, { fetchImpl: routeFetch(espn, fakeTsdb({ now: T0 })), now: () => T0 + 600_000 }));
  const second = espn.log.length - before;
  assert.ok(second < before / 2, `build kedua jauh lebih hemat: ${second} vs ${before}`);
});

test('build auto: TheSportsDB menjawab 403 -> ESPN tetap dipakai dan penolakan terlihat di meta.json (bukan "0 gagal")', async () => {
  const espn = fakeEspnSite({ now: T0 });
  const blocked = { impl: async () => new Response('forbidden', { status: 403 }) };
  const r = await buildPages(buildOpts(tmp('b403'), tmp('b403s'), { fetchImpl: routeFetch(espn, blocked) }));
  assert.equal(r.outcome, 'fresh');
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.equal(meta.demo, false);
  assert.ok(meta.sources.thesportsdb.rejected > 0, 'penolakan 403 tercatat');
  assert.equal(meta.sources.thesportsdb.ok, 0);
});

test('build auto: ESPN mati -> TheSportsDB saja, tetap segar; sebagian liga gagal -> sisanya tetap', async () => {
  const dead = fakeEspnSite({ now: T0, failAll: true });
  const r = await buildPages(buildOpts(tmp('d1'), tmp('d1s'), { fetchImpl: routeFetch(dead, fakeTsdb({ now: T0 })) }));
  assert.equal(r.outcome, 'fresh');
  const snap = readJ(r.outDir, 'data/matches.json');
  assert.ok(snap.matches.length > 100 && snap.matches.every((m) => m.id.startsWith('tsdb:')));
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.equal(meta.sources.espn.ok, 0);

  const part = fakeEspnSite({ now: T0, failPaths: ['soccer/eng.1', 'hockey/nhl'] });
  const r2 = await buildPages(buildOpts(tmp('d2'), tmp('d2s'), { fetchImpl: routeFetch(part, fakeTsdb({ now: T0 })) }));
  assert.equal(r2.outcome, 'fresh');
  const m2 = readJ(r2.outDir, 'data/meta.json');
  assert.deepEqual(m2.sources.espn.failed.sort(), ['hockey/nhl', 'soccer/eng.1']);
  assert.equal(m2.sources.espn.ok, ENDPOINTS.length - 2);
  const s2 = readJ(r2.outDir, 'data/matches.json');
  assert.ok(s2.matches.some((m) => m.feed === 'soccer/esp.1') && !s2.matches.some((m) => m.feed === 'soccer/eng.1'));
});

test('build auto: kedua sumber mati -> data lama ditandai tertunda; tanpa data lama -> demo berlabel', async () => {
  const state = tmp('b3s');
  const base = { fetchImpl: routeFetch(fakeEspnSite({ now: T0, failAll: true }), fakeTsdb({ now: T0, failAll: true })) };
  const r1 = await buildPages(buildOpts(tmp('b3a'), state, base));
  assert.equal(r1.outcome, 'demo');
  assert.equal(readJ(r1.outDir, 'data/config.json').demo, true);
  assert.equal(readJ(r1.outDir, 'data/config.json').fallbackActive, true);
  assert.ok(!fs.existsSync(path.join(state, 'last-data')), 'data demo tidak disimpan sebagai data terakhir');
  // meta.json harus memuat alasan asli kegagalan (bukan hanya pesan umum), supaya bisa didiagnosis tanpa membuka log build
  const why = readJ(r1.outDir, 'data/meta.json').lastError;
  assert.match(why, /ESPN tidak bisa dihubungi/, `alasan ESPN tercatat: ${why}`);
  assert.match(why, /thesportsdb/i, `alasan TheSportsDB tercatat: ${why}`);
  assert.ok(why.length <= 500);

  const good = await buildPages(buildOpts(tmp('b3b'), state, { fetchImpl: routeFetch(fakeEspnSite({ now: T0 }), fakeTsdb({ now: T0 })), now: () => T0 + 600_000 }));
  assert.equal(good.outcome, 'fresh');
  const r3 = await buildPages(buildOpts(tmp('b3c'), state, { ...base, now: () => T0 + 30 * 24 * HOUR }));
  assert.equal(r3.outcome, 'stale');
  assert.equal(readJ(r3.outDir, 'data/matches.json').meta.stale, true);
});

test('build espn saja dan pilihan sumber tidak dikenal', async () => {
  const espn = fakeEspnSite({ now: T0 });
  const tsdb = fakeTsdb({ now: T0 });
  const r = await buildPages(buildOpts(tmp('e1'), tmp('e1s'), { provider: 'espn', fetchImpl: routeFetch(espn, tsdb) }));
  assert.equal(r.outcome, 'fresh');
  assert.equal(tsdb.log.length, 0, 'TheSportsDB tidak dipanggil');
  const snap = readJ(r.outDir, 'data/matches.json');
  assert.ok(snap.matches.length > 100 && snap.matches.every((m) => m.id.startsWith('espn:')));
  assert.equal(readJ(r.outDir, 'data/config.json').provider, 'espn');
  await assert.rejects(() => buildPages(buildOpts(tmp('e2'), tmp('e2s'), { provider: 'sofascore', fetchImpl: routeFetch(espn, tsdb) })), /tidak dikenal/);
});

/* ------------------------------------------------------------------ build auto + API publik tanpa kunci */

test('build auto: API publik (OpenLigaDB/MLB/NHL) menambah laga di antara ESPN dan TheSportsDB; kegagalan satu sumber tercatat, bukan fatal', async () => {
  const iso = (o) => new Date(T0 + o * 3_600_000).toISOString();
  const mlb = { dates: [{ games: [
    { gamePk: 777001, gameDate: iso(5), status: { abstractGameState: 'Preview', detailedState: 'Scheduled' }, teams: { away: { team: { name: 'Zzyzx Comets' } }, home: { team: { name: 'Qwerty Owls' } } } },
  ] }] };
  const nhl = { games: [{ id: 888001, startTimeUTC: iso(6), gameState: 'FUT', awayTeam: { name: { default: 'Narwhals' }, placeName: { default: 'Zzyzx' }, abbrev: 'ZZY' }, homeTeam: { name: { default: 'Owls' }, placeName: { default: 'Qwerty' }, abbrev: 'QWE' } }] };
  const mkPub = ({ failMlb = false } = {}) => async (url) => {
    const u = String(url);
    if (u.includes('statsapi.mlb.com')) return failMlb ? new Response('x', { status: 500 }) : new Response(JSON.stringify(mlb));
    if (u.includes('api-web.nhle.com')) return new Response(JSON.stringify(u.endsWith(new Date(T0).toISOString().slice(0, 10)) ? nhl : { games: [] }));
    return new Response('[]');
  };
  const logs = [];
  const r = await buildPages(buildOpts(tmp('pub'), tmp('pubstate'), { fetchImpl: routeFetch3(fakeEspnSite({ now: T0 }), mkPub(), fakeTsdb({ now: T0 })), log: (...a) => logs.push(a.join(' ')) }));
  assert.equal(r.outcome, 'fresh');
  const snap = readJ(r.outDir, 'data/matches.json');
  const pubM = snap.matches.filter((m) => m.id.startsWith('pub:'));
  assert.ok(pubM.some((m) => m.id === 'pub:mlb-777001' && m.home.name === 'Qwerty Owls' && m.source === 'public'), pubM.map((m) => m.id).join());
  assert.ok(pubM.some((m) => m.id === 'pub:nhl-888001'));
  assert.equal(new Set(snap.matches.map((m) => m.id)).size, snap.matches.length);
  assert.ok(snap.matches.some((m) => m.id.startsWith('espn:')) && snap.matches.some((m) => m.id.startsWith('tsdb:')));
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.equal(meta.sources.public.mlb.ok, true);
  assert.equal(meta.sources.public.nhl.ok, true);
  assert.ok(logs.some((l) => /API publik:.*mlb 1 laga/.test(l)), logs.filter((l) => /publik/i.test(l)).join('\n'));
  // detail laga publik bisa dibuka lewat berkas per-pertandingan
  assert.ok(fs.existsSync(path.join(r.outDir, 'data', matchFile('pub:mlb-777001'))));

  // MLB mati: build tetap sukses, kegagalan tercatat dan terlihat di log
  const logs2 = [];
  const r2 = await buildPages(buildOpts(tmp('pub2'), tmp('pub2state'), { fetchImpl: routeFetch3(fakeEspnSite({ now: T0 }), mkPub({ failMlb: true }), fakeTsdb({ now: T0 })), log: (...a) => logs2.push(a.join(' ')) }));
  assert.equal(r2.outcome, 'fresh');
  const m2 = readJ(r2.outDir, 'data/meta.json');
  assert.equal(m2.sources.public.mlb.ok, false);
  assert.equal(m2.sources.public.nhl.ok, true);
  assert.ok(logs2.some((l) => /mlb GAGAL/.test(l)));
  assert.ok(!readJ(r2.outDir, 'data/matches.json').matches.some((m) => m.id.startsWith('pub:mlb:')));
});

/* ------------------------------------------------------------------ build auto + statistik lengkap */

test('build auto: statistik lengkap masuk bundel laga; laga selesai tidak diminta ulang; kegagalan tercatat, bukan fatal', async () => {
  const summary = (id) => ({
    header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: `h${id}` } }, { homeAway: 'away', team: { id: `a${id}` } }] }] },
    boxscore: { teams: [
      { team: { id: `h${id}` }, homeAway: 'home', statistics: [{ name: 'totalShots', displayValue: '11' }, { name: 'possessionPct', displayValue: '60' }] },
      { team: { id: `a${id}` }, homeAway: 'away', statistics: [{ name: 'totalShots', displayValue: '7' }, { name: 'possessionPct', displayValue: '40' }] },
    ] },
    keyEvents: [{ type: { text: 'Goal' }, scoringPlay: true, team: { id: `h${id}` }, clock: { displayValue: "10'" }, participants: [{ athlete: { displayName: 'Pemain Uji' } }] }],
  });
  const asked = [];
  const wrap = (inner, { failSummary = false } = {}) => async (url, init) => {
    const u = String(url);
    const m = /\/summary\?event=([0-9]+)$/.exec(u);
    if (m) { asked.push(m[1]); return failSummary ? new Response('x', { status: 500 }) : new Response(JSON.stringify(summary(m[1]))); }
    return inner(url, init);
  };
  const state = tmp('statsstate');
  const mk = (over = {}) => buildOpts(tmp('stats'), state, over);
  const espn = fakeEspnSite({ now: T0 });
  const pub = async () => new Response('[]');
  const logs = [];
  const r = await buildPages(mk({ fetchImpl: wrap(routeFetch3(espn, pub, fakeTsdb({ now: T0 }))), log: (...a) => logs.push(a.join(' ')), statsMax: 15 }));
  assert.equal(r.outcome, 'fresh');
  const snap = readJ(r.outDir, 'data/matches.json');
  const withStats = snap.matches.filter((m) => m.id.startsWith('espn:') && ['live', 'finished'].includes(m.status)).map((m) => ({ m, b: readJ(r.outDir, 'data', matchFile(m.id)) })).filter((x) => x.b.match.stats?.length);
  assert.ok(withStats.length >= 5 && withStats.length <= 15, `bundel ber-statistik: ${withStats.length}`);
  const { b } = withStats[0];
  assert.deepEqual(b.match.stats.map((s) => [s.label, s.home, s.away]), [['Tembakan', 11, 7], ['Penguasaan bola', 60, 40]]);
  assert.equal(b.match.events[0].player, 'Pemain Uji');
  assert.ok(!snap.matches.some((m) => m.stats || m.events?.length), 'daftar laga tetap ringan: statistik hanya di bundel');
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.equal(meta.sources.stats.fetched, asked.length);
  assert.ok(meta.sources.stats.skippedByCap > 0 && meta.sources.stats.withData === withStats.length);
  assert.ok(logs.some((l) => /Statistik laga: \d+ berisi/.test(l)));

  // build berikutnya: yang selesai dan sudah tersimpan tidak diminta lagi
  const before = new Set(asked);
  asked.length = 0;
  await buildPages(mk({ fetchImpl: wrap(routeFetch3(espn, pub, fakeTsdb({ now: T0 }))), now: () => T0 + 600_000, statsMax: 15 }));
  const finishedIds = new Set(snap.matches.filter((m) => m.status === 'finished').map((m) => m.espnId));
  assert.ok(![...before].filter((id) => finishedIds.has(id)).some((id) => asked.includes(id)), 'laga selesai bersimpanan tidak diambil ulang');

  // endpoint statistik mati: build tetap sukses, kegagalan tercatat
  const r3 = await buildPages(buildOpts(tmp('stats3'), tmp('stats3s'), { fetchImpl: wrap(routeFetch3(espn, pub, fakeTsdb({ now: T0 })), { failSummary: true }), statsMax: 6 }));
  assert.equal(r3.outcome, 'fresh');
  const m3 = readJ(r3.outDir, 'data/meta.json');
  assert.equal(m3.sources.stats.withData, 0);
  assert.ok(m3.sources.stats.errors.length > 0 && /HTTP 500/.test(m3.sources.stats.errors[0].error));
});

/* ------------------------------------------------------------------ tenis dan rugby (ESPN) */

import { overlayOf } from '../public/js/static/espn.js';

const iso = (o) => new Date(T0 + o * HOUR).toISOString();
const tPlayer = (order, name, sets, extra = {}) => ({ order, athlete: { displayName: name, shortName: extra.short || name }, linescores: sets.map((v) => ({ value: v })) });
const tComp = (id, off, state, name, completed, a, b, extra = {}) => ({ id, date: iso(off), status: { type: { state, name, completed } }, competitors: [a, b], ...extra });
const TENNIS = { leagues: [{ name: 'Association of Tennis Professionals' }], events: [{ id: '900', name: 'Rolex Paris Masters', shortName: 'Paris Masters', groupings: [
  { grouping: { displayName: "Men's Singles" }, competitions: [
    tComp('t1', -1, 'in', 'STATUS_IN_PROGRESS', false, tPlayer(1, 'Jannik Sinner', [6, 3], { short: 'J. Sinner' }), tPlayer(2, 'Carlos Alcaraz', [4, 2])),
    tComp('t2', -9, 'post', 'STATUS_FINAL', true, tPlayer(1, 'Alexander Zverev', [6, 3, 7]), tPlayer(2, 'Daniil Medvedev', [4, 6, 6])),
    tComp('t3', 6, 'pre', 'STATUS_SCHEDULED', false, tPlayer(1, 'Taylor Fritz', []), tPlayer(2, 'Casper Ruud', [])),
    tComp('t4', 7, 'pre', 'STATUS_SCHEDULED', false, tPlayer(1, 'TBD', []), tPlayer(2, 'Casper Ruud', [])),
    tComp('t5', -20, 'post', 'STATUS_RETIRED', true, tPlayer(1, 'Pemain Mundur', [3]), tPlayer(2, 'Pemain Lawan', [2])),
    tComp('t6', -2, 'in', 'STATUS_IN_PROGRESS', false, tPlayer(1, 'Tanpa Jam', [1]), tPlayer(2, 'Tanpa Jam Lawan', [0]), { date: undefined }),
  ] },
  { grouping: { displayName: "Men's Doubles" }, competitions: [
    tComp('d1', -3, 'post', 'STATUS_FINAL', true, { order: 1, roster: { displayName: 'Ram / Salisbury' }, linescores: [{ value: 6 }, { value: 6 }] }, { order: 2, roster: { displayName: 'Koolhof / Mektic' }, linescores: [{ value: 3 }, { value: 4 }] }),
  ] },
] }] };

test('tenis ESPN: undian dibaca jadi pertandingan; skor = set menang; game per set; TBD, mundur, tanpa jam dibuang', () => {
  const evs = parseScoreboard(TENNIS);
  assert.deepEqual(evs.map((e) => e.id), ['t1', 't2', 't3', 't5', 'd1'], 't4 (TBD) dan t6 (tanpa jam) dibuang');
  assert.deepEqual([evs.find((e) => e.id === 't5').home.score, evs.find((e) => e.id === 't5').away.score], [null, null], 'mundur tanpa set selesai: tanpa hasil yang bisa dipakai');
  const by = Object.fromEntries(evs.map((e) => [e.id, e]));
  assert.deepEqual([by.t1.home.score, by.t1.away.score, by.t1.sets], [1, 0, [[6, 4], [3, 2]]], 'set 2 (3-2) belum selesai');
  assert.deepEqual([by.t2.home.score, by.t2.away.score], [2, 1], '7-6 di set penentu = selesai');
  assert.equal(by.t3.home.score, 0);
  assert.equal(by.t1.tournament, 'Paris Masters');
  assert.equal(by.t1.draw, "Men's Singles");
  assert.ok(by.t1.home.names.includes('J. Sinner'));
  assert.equal(by.d1.home.names[0], 'Ram / Salisbury', 'ganda memakai nama pasangan');
});

test('tenis ESPN: toMatch memberi liga tur+turnamen, set demi set sebagai statistik, status benar', () => {
  const ms = parseScoreboard(TENNIS).map((e) => toMatch(e, ep('tennis/atp'), 'Association of Tennis Professionals')).filter(Boolean);
  const by = Object.fromEntries(ms.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(by).sort(), ['espn:d1', 'espn:t1', 'espn:t2', 'espn:t3']);
  assert.equal(by['espn:t1'].sport, 'tennis');
  assert.equal(by['espn:t1'].league, 'ATP Tour: Paris Masters');
  assert.equal(by['espn:t1'].feed, 'tennis/atp');
  assert.deepEqual([by['espn:t1'].status, by['espn:t1'].score, by['espn:t1'].period], ['live', { home: 1, away: 0 }, 'Set 2 (3-2)']);
  assert.deepEqual(by['espn:t1'].stats, [{ label: 'Set 1 (game)', home: 6, away: 4 }, { label: 'Set 2 (game)', home: 3, away: 2 }]);
  assert.deepEqual([by['espn:t2'].status, by['espn:t2'].score, by['espn:t2'].period], ['finished', { home: 2, away: 1 }, 'Selesai']);
  assert.equal(by['espn:t3'].status, 'upcoming');
  assert.equal(by['espn:t3'].stats, null, 'laga belum mulai: tanpa statistik');
  for (const m of ms) assert.ok(MATCH_ID_RE.test(m.id) && matchFile(m.id), `id sah: ${m.id}`);
});

test('tenis ESPN: overlay live dari browser (set dan game), peristiwa tanpa set tidak menimpa apa pun', () => {
  const ev = parseScoreboard(TENNIS).find((e) => e.id === 't1');
  const o = overlayOf({ sport: 'tennis', league: 'ATP Tour: Paris Masters' }, ev, false);
  assert.deepEqual([o.status, o.score, o.period, o.minute, o.progress], ['live', { home: 1, away: 0 }, 'Set 2 (3-2)', null, null]);
  const sw = overlayOf({ sport: 'tennis', league: 'x' }, ev, true);
  assert.deepEqual(sw.score, { home: 0, away: 1 }, 'urutan terbalik antara snapshot dan ESPN');
  assert.equal(overlayOf({ sport: 'tennis', league: 'x' }, { ...ev, sets: undefined }, false), null);
  const pre = parseScoreboard(TENNIS).find((e) => e.id === 't3');
  assert.equal(overlayOf({ sport: 'tennis', league: 'x' }, pre, false), null, 'belum mulai');
});

test('tenis ESPN: penyedia memanggil atp/wta dan memberi laga tenis; endpoint tenis ada untuk laga TheSportsDB', async () => {
  const seenUrls = [];
  const impl = async (url) => { seenUrls.push(String(url)); return new Response(JSON.stringify(/tennis\/atp\//.test(String(url)) ? TENNIS : { events: [] })); };
  const p = createEspnProvider({ fetchImpl: impl, now: () => T0 });
  const rows = await p.listMatches({ from: T0 - 6 * HOUR, to: T0 + 30 * HOUR, sports: ['tennis'] });
  assert.ok(seenUrls.length >= 2 && seenUrls.every((u) => /\/tennis\/(atp|wta)\/scoreboard/.test(u)), seenUrls.join('\n'));
  assert.deepEqual(rows.map((m) => m.id).sort(), ['espn:d1', 'espn:t1', 'espn:t2', 'espn:t3'].sort().filter((id) => rows.some((m) => m.id === id)));
  assert.ok(rows.some((m) => m.id === 'espn:t1') && rows.every((m) => m.sport === 'tennis'));
  assert.equal(endpointsFor({ sport: 'tennis', league: 'ATP Tour' })[0].path, 'tennis/atp');
  assert.equal(endpointsFor({ sport: 'tennis', league: 'WTA Finals' })[0].path, 'tennis/wta');
});

const RUGBY_LIST = { items: [{ $ref: 'http://sports.core.api.espn.com/v2/sports/rugby/leagues/164205?lang=en&region=us' }, { $ref: 'http://sports.core.api.espn.com/v2/sports/rugby/leagues/270557' }, { $ref: 'bukan-liga' }, { id: '999' }, { $ref: 'http://x/leagues/164205' }] };
const rugbyBoard = (id) => board(
  espnEvent({ id: `${id}1`, date: T0 - 0.5 * HOUR, home: 'Leinster', away: 'Munster', hs: 17, as: 10, state: 'in', period: 1, clock: "33'" }),
  espnEvent({ id: `${id}2`, date: T0 - 1.5 * HOUR, home: 'Ulster', away: 'Ospreys', hs: 21, as: 21, state: 'in', name: 'STATUS_HALFTIME', period: 1, clock: "40'" }),
  espnEvent({ id: `${id}3`, date: T0 + 5 * HOUR, home: 'Glasgow', away: 'Cardiff', state: 'pre', name: 'STATUS_SCHEDULED' }),
  espnEvent({ id: `${id}4`, date: T0 - 20 * HOUR, home: 'Benetton', away: 'Zebre', hs: 30, as: 12, state: 'post', name: 'STATUS_FULL_TIME', completed: true, period: 2 }),
);

test('rugby ESPN: liga ditemukan dari daftar ESPN, jam rugby (babak, 80 menit), hasil, dan laporan penemuan', async () => {
  const seenUrls = [];
  const impl = async (url) => {
    const u = String(url);
    seenUrls.push(u);
    if (/sports\.core\.api\.espn\.com\/v2\/sports\/rugby\/leagues/.test(u)) return new Response(JSON.stringify(RUGBY_LIST));
    const m = /\/rugby\/(\d+)\/scoreboard/.exec(u);
    return new Response(JSON.stringify(m ? { leagues: [{ name: m[1] === '164205' ? 'United Rugby Championship' : 'Premiership Rugby' }], ...rugbyBoard(m[1]) } : { events: [] }));
  };
  const p = createEspnProvider({ fetchImpl: impl, now: () => T0, leagues: [], rugbyDiscovery: true });
  const rows = await p.listMatches({ from: T0 - 24 * HOUR, to: T0 + 30 * HOUR, sports: ['rugby'] });
  assert.deepEqual(p.report.rugby, { ok: true, leagues: 3, found: 3 }, 'tiga id unik: 164205, 270557, 999');
  assert.ok(seenUrls.some((u) => /\/rugby\/164205\/scoreboard/.test(u)) && seenUrls.some((u) => /\/rugby\/999\/scoreboard/.test(u)));
  assert.equal(seenUrls.filter((u) => /core\.api/.test(u)).length, 1, 'penemuan satu kali');
  const m = rows.find((x) => x.id === 'espn:1642051');
  assert.deepEqual([m.sport, m.feed, m.league, m.status, m.score, m.period, m.minute], ['rugby', 'rugby/164205', 'United Rugby Championship', 'live', { home: 17, away: 10 }, 'Babak 1', 33]);
  assert.ok(Math.abs(m.progress - 33 / 80) < 1e-9);
  const ht = rows.find((x) => x.id === 'espn:1642052');
  assert.deepEqual([ht.period, ht.minute, ht.progress], ['Turun minum', 40, 0.5]);
  assert.equal(rows.find((x) => x.id === 'espn:1642054').status, 'finished');
  assert.equal(rows.find((x) => x.id === 'espn:1642053').status, 'upcoming');
  assert.ok(MATCH_ID_RE.test(m.id) && matchFile(m.id));
  assert.equal((await p.getMatch('espn:1642051')).id, 'espn:1642051', 'getMatch menemukan liga rugby hasil penemuan');
  await p.listMatches({ from: T0 - 24 * HOUR, to: T0 + 30 * HOUR, sports: ['rugby'] });
  assert.equal(seenUrls.filter((u) => /core\.api/.test(u)).length, 1, 'tidak ditanya ulang');
});

test('rugby ESPN: penemuan gagal atau mati tidak mematikan sumber lain; tanpa opsi tidak ada permintaan inti', async () => {
  const dead = createEspnProvider({ fetchImpl: async (u) => (/core\.api/.test(String(u)) ? new Response('x', { status: 500 }) : new Response(JSON.stringify({ events: [] }))), now: () => T0, leagues: ENDPOINTS.filter((e) => e.sport === 'basketball'), rugbyDiscovery: true, log: quiet });
  const rows = await dead.listMatches({ from: T0 - DAY, to: T0 + DAY });
  assert.deepEqual(rows, []);
  assert.equal(dead.report.rugby.ok, false);
  assert.match(dead.report.rugby.error, /HTTP 500/);
  assert.ok(dead.report.ok >= 1, 'liga lain tetap dibaca');
  const seenUrls = [];
  const off = createEspnProvider({ fetchImpl: async (u) => { seenUrls.push(String(u)); return new Response(JSON.stringify({ events: [] })); }, now: () => T0, leagues: ENDPOINTS.filter((e) => e.sport === 'basketball') });
  await off.listMatches({ from: T0 - DAY, to: T0 + DAY });
  assert.ok(!seenUrls.some((u) => /core\.api/.test(u)));
  assert.equal(off.report.rugby, undefined);
  const junk = createEspnProvider({ fetchImpl: async () => new Response('<html>'), now: () => T0, leagues: [], rugbyDiscovery: true, log: quiet });
  assert.deepEqual(await junk.listMatches({ from: T0 - DAY, to: T0 + DAY, sports: ['rugby'] }), []);
  assert.equal(junk.report.rugby.ok, false);
});

test('rugby ESPN: overlay browser memakai jam rugby (80 menit) untuk laga dari ESPN', () => {
  const ev = parseScoreboard(rugbyBoard('55'))[0];
  const o = overlayOf({ sport: 'rugby', league: 'URC' }, ev, false);
  assert.deepEqual([o.status, o.score, o.period, o.minute], ['live', { home: 17, away: 10 }, 'Babak 1', 33]);
  const fin = overlayOf({ sport: 'rugby', league: 'URC' }, parseScoreboard(rugbyBoard('55'))[3], false);
  assert.deepEqual([fin.status, fin.period, fin.progress], ['finished', 'Selesai', 1]);
});

test('build: tenis dan rugby dari ESPN masuk snapshot dan bundel (set demi set), penemuan rugby tercatat di meta', async () => {
  const site = fakeEspnSite({ now: T0 });
  const impl = async (url, init) => {
    const u = String(url);
    if (/core\.api\.espn\.com\/v2\/sports\/rugby\/leagues/.test(u)) return new Response(JSON.stringify({ items: [{ $ref: 'http://sports.core.api.espn.com/v2/sports/rugby/leagues/270557' }] }));
    const r = /\/rugby\/(\d+)\/scoreboard/.exec(u);
    if (r) return new Response(JSON.stringify({ leagues: [{ name: 'United Rugby Championship' }], ...rugbyBoard(r[1]) }));
    if (/\/tennis\/atp\/scoreboard/.test(u)) return new Response(JSON.stringify(TENNIS));
    if (/\/summary\?event=/.test(u)) return new Response(JSON.stringify({}));
    return site.impl(url, init);
  };
  const logs = [];
  const r = await buildPages(buildOpts(tmp('tr'), tmp('trs'), { provider: 'espn', fetchImpl: impl, log: (...a) => logs.push(a.join(' ')) }));
  assert.equal(r.outcome, 'fresh');
  const snap = readJ(r.outDir, 'data/matches.json');
  const ten = snap.matches.filter((m) => m.sport === 'tennis');
  const rug = snap.matches.filter((m) => m.sport === 'rugby');
  assert.ok(ten.some((m) => m.id === 'espn:t1' && m.league === 'ATP Tour: Paris Masters'), ten.map((m) => m.id).join());
  assert.ok(rug.length >= 3 && rug.every((m) => m.feed === 'rugby/270557' && m.league === 'United Rugby Championship'));
  const b = readJ(r.outDir, 'data', matchFile('espn:t1'));
  assert.deepEqual(b.match.stats.map((s) => [s.label, s.home, s.away]), [['Set 1 (game)', 6, 4], ['Set 2 (game)', 3, 2]]);
  assert.equal(b.match.score.home, 1);
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.deepEqual(meta.sources.espn.rugby, { ok: true, leagues: 1, found: 1 });
  assert.ok(logs.some((l) => /ESPN rugby: 1 liga ditemukan/.test(l)), logs.filter((l) => /rugby/i.test(l)).join('\n'));
});

test('build: susunan pemain (sepak bola dan basket) masuk bundel laga, tidak masuk daftar laga, dan tercatat di meta', async () => {
  const summaryFor = (feed, id) => {
    const base = { header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: `h${id}` } }, { homeAway: 'away', team: { id: `a${id}` } }] }] }, boxscore: { teams: [{ team: { id: `h${id}` }, homeAway: 'home', statistics: [] }, { team: { id: `a${id}` }, homeAway: 'away', statistics: [] }] } };
    if (feed.startsWith('soccer/')) {
      const side = (ha, f) => ({ homeAway: ha, team: { id: `${ha[0]}${id}` }, formation: f, roster: [...Array.from({ length: 11 }, (_, i) => ({ starter: true, formationPlace: String(i + 1), jersey: String(i + 1), athlete: { displayName: `Pemain ${ha} ${i + 1}` }, position: { abbreviation: 'M' }, stats: [] })), { starter: false, jersey: '20', athlete: { displayName: `Cadangan ${ha}` }, stats: [] }] });
      return { ...base, rosters: [side('home', '4-4-2'), side('away', '3-5-2')] };
    }
    if (feed === 'basketball/nba') {
      const labels = ['MIN', 'PTS', 'REB', 'AST'];
      const pl = (ha) => ({ team: { id: `${ha[0]}${id}` }, statistics: [{ labels, athletes: [{ starter: true, athlete: { displayName: `Bintang ${ha}`, jersey: '1' }, stats: ['30', '20', '5', '5'] }] }] });
      return { ...base, boxscore: { ...base.boxscore, players: [pl('home'), pl('away')] } };
    }
    return base;
  };
  const wrap = (inner) => async (url, init) => {
    const m = /\/sports\/([a-z]+\/[a-z0-9.]+)\/summary\?event=([0-9]+)$/.exec(String(url));
    return m ? new Response(JSON.stringify(summaryFor(m[1], m[2]))) : inner(url, init);
  };
  const espn = fakeEspnSite({ now: T0 });
  const pub = async () => new Response('[]');
  const r = await buildPages(buildOpts(tmp('lu'), tmp('lus'), { fetchImpl: wrap(routeFetch3(espn, pub, fakeTsdb({ now: T0 }))), statsMax: 60 }));
  assert.equal(r.outcome, 'fresh');
  const snap = readJ(r.outDir, 'data/matches.json');
  assert.ok(!snap.matches.some((m) => m.lineups), 'daftar laga tetap ringan');
  const bundles = snap.matches.filter((m) => m.id.startsWith('espn:') && ['live', 'finished'].includes(m.status)).map((m) => ({ m, b: readJ(r.outDir, 'data', matchFile(m.id)) }));
  const soccer = bundles.find((x) => x.m.sport === 'football' && x.b.match.lineups);
  const basket = bundles.find((x) => x.m.sport === 'basketball' && x.b.match.lineups);
  assert.ok(soccer, 'ada laga sepak bola dengan susunan');
  assert.equal(soccer.b.match.lineups.kind, 'soccer');
  assert.equal(soccer.b.match.lineups.home.formation, '4-4-2');
  assert.equal(soccer.b.match.lineups.away.starters.length, 11);
  assert.ok(basket, 'ada laga basket dengan susunan');
  assert.deepEqual(basket.b.match.lineups.columns, ['MIN', 'PTS', 'REB', 'AST']);
  assert.deepEqual(basket.b.match.lineups.home.starters[0].s, ['30', '20', '5', '5']);
  assert.ok(bundles.filter((x) => !['football', 'basketball'].includes(x.m.sport)).every((x) => !x.b.match.lineups), 'cabang lain tanpa susunan');
  const meta = readJ(r.outDir, 'data/meta.json');
  assert.ok(meta.sources.stats.lineups >= 2, `meta.sources.stats.lineups=${meta.sources.stats.lineups}`);
});

// Tes kejadian skor langsung (gol, mulai, selesai) dan polling saat tab tersembunyi, tanpa jaringan sungguhan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFeed } from '../public/js/static/live.js';
import { analyze, pickOf } from '../server/model/model.js';
import { explain } from '../server/ai/explainer.js';
import { ESPN_ORIGIN } from '../public/js/static/espn.js';
import { board, espnEvent, fakeEspn } from './fake-espn.js';

const T0 = Date.parse('2026-11-18T14:00:00Z');
const MIN = 60_000;
const PL = `${ESPN_ORIGIN}/apis/site/v2/sports/soccer/eng.1/scoreboard`;
const PROXY = 'https://jonbet-live.akmal.workers.dev/live';
const mk = (over = {}) => ({
  id: 'tsdb:1', sport: 'football', league: 'English Premier League', home: { name: 'Manchester City' }, away: { name: 'Arsenal' },
  kickoff: new Date(T0 - 30 * MIN).toISOString(), status: 'live', minute: 30, period: 'Babak 1', progress: 0.33, score: { home: 0, away: 0 },
  forecast: { home: 0.5, draw: 0.25, away: 0.25, pick: 'H', pickP: 0.5, confidence: 40, live: true }, ...over,
});
const ev = (hs, as, clock = "35'", extra = {}) => espnEvent({ id: 'c1', date: T0 - 30 * MIN, home: 'Manchester City', away: 'Arsenal', hs, as, clock, period: 1, ...extra });
const fin = (hs, as) => espnEvent({ id: 'c1', date: T0 - 30 * MIN, home: 'Manchester City', away: 'Arsenal', hs, as, state: 'post', name: 'STATUS_FULL_TIME', completed: true, period: 2 });

function rig({ matches = [mk()], routes, visible = () => true, hiddenOk = () => false, proxyBody = null } = {}) {
  let t = T0;
  const espn = fakeEspn(routes || { [PL]: board(ev(0, 0)) });
  const events = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === PROXY) return new Response(JSON.stringify(proxyBody()));
    return espn(url, init);
  };
  const snap = { builtAt: new Date(T0 - 5 * MIN).toISOString(), matches };
  const feed = createLiveFeed({
    getSnapshot: async () => snap, getBundle: async () => ({ match: matches[0], ratings: null }), sportOf: () => null,
    proxyUrl: proxyBody ? PROXY : null, model: { analyze, pickOf }, explain, fetchImpl, now: () => t, visible, hiddenOk, onEvent: (e) => events.push(e),
  });
  return { feed, espn, events, advance: (ms) => { t += ms; }, set: (r) => { espn.routes[PL] = r; } };
}
const types = (events) => events.map((e) => `${e.type}${e.side || ''}`);

test('kejadian: pengamatan pertama hanya dasar; gol, gol balasan, dan peluit akhir dilaporkan sekali', async () => {
  const r = rig();
  await r.feed.tick();
  assert.deepEqual(r.events, [], 'pengamatan pertama tidak menghasilkan kejadian');
  await r.feed.tick();
  assert.deepEqual(r.events, [], 'tidak berubah: tidak ada kejadian');
  r.set(board(ev(1, 0, "37'")));
  await r.feed.tick();
  assert.deepEqual(types(r.events), ['goalH']);
  assert.deepEqual([r.events[0].score, r.events[0].minute, r.events[0].match.id, r.events[0].src], [{ home: 1, away: 0 }, 37, 'tsdb:1', 'ESPN']);
  await r.feed.tick();
  assert.equal(r.events.length, 1, 'skor sama diulang: tidak ada gol baru');
  r.set(board(ev(1, 1, "50'")));
  await r.feed.tick();
  r.set(board(fin(2, 1)));
  await r.feed.tick();
  assert.deepEqual(types(r.events), ['goalH', 'goalA', 'goalH', 'end'], 'gol terakhir lalu peluit akhir');
  r.set(board(fin(2, 1)));
  await r.feed.tick();
  assert.equal(r.events.length, 4, 'selesai tidak dilaporkan ulang');
});

test('kejadian: skor turun (koreksi) tidak melaporkan apa pun; gol dua sekaligus dilaporkan per sisi', async () => {
  const r = rig({ routes: { [PL]: board(ev(2, 0, "60'")) } });
  await r.feed.tick();
  r.set(board(ev(1, 0, "61'")));
  await r.feed.tick();
  assert.deepEqual(r.events, [], 'gol dianulir: tidak ada kejadian');
  r.set(board(ev(3, 2, "66'")));
  await r.feed.tick();
  assert.deepEqual(types(r.events), ['goalH', 'goalA']);
});

test('kejadian: dua sumber yang berselisih sesaat tidak membuat gol ganda', async () => {
  let proxy = { ok: true, label: 'API-Football', at: T0, events: [] };
  const mkP = (hs, as) => ({ id: 'af:1', sport: 'football', league: 'PL', kickoff: T0 - 30 * MIN, home: 'Manchester City', away: 'Arsenal', hs, as, state: 'in', code: '', minute: 40, period: 'Babak 1' });
  const r = rig({ proxyBody: () => proxy });
  proxy.events = [mkP(0, 0)];
  await r.feed.tick();
  proxy.events = [mkP(1, 0)]; // proxy lebih cepat; ESPN masih 0-0
  for (let i = 0; i < 4; i++) await r.feed.tick();
  assert.deepEqual(types(r.events), ['goalH'], 'satu gol walau ESPN dan proxy bergantian tiap putaran');
  assert.equal(r.events[0].src, 'API-Football');
});

test('kejadian: laga yang di snapshot "akan mulai" lalu terlihat live baru saja = mulai; sudah lama berjalan = tidak', async () => {
  const up = mk({ status: 'upcoming', minute: null, score: null, period: null, progress: null, kickoff: new Date(T0 - 2 * MIN).toISOString() });
  const a = rig({ matches: [up], routes: { [PL]: board(espnEvent({ id: 'c1', date: T0 - 2 * MIN, home: 'Manchester City', away: 'Arsenal', hs: 0, as: 0, clock: "2'", period: 1 })) } });
  await a.feed.tick();
  assert.deepEqual(types(a.events), ['start']);
  const old = mk({ status: 'upcoming', minute: null, score: null, period: null, progress: null, kickoff: new Date(T0 - 40 * MIN).toISOString() });
  const b = rig({ matches: [old], routes: { [PL]: board(espnEvent({ id: 'c1', date: T0 - 40 * MIN, home: 'Manchester City', away: 'Arsenal', hs: 2, as: 1, clock: "40'", period: 1 })) } });
  await b.feed.tick();
  assert.deepEqual(b.events, [], 'baru dibuka saat laga sudah berjalan: tidak ada notifikasi basi');
});

test('kejadian: pendengar yang melempar galat tidak menghentikan pemantauan', async () => {
  let t = T0;
  const espn = fakeEspn({ [PL]: board(ev(0, 0)) });
  const feed = createLiveFeed({ getSnapshot: async () => ({ builtAt: new Date(T0).toISOString(), matches: [mk()] }), getBundle: async () => ({}), model: { analyze, pickOf }, explain, fetchImpl: espn, now: () => t, onEvent: () => { throw new Error('boom'); } });
  await feed.tick();
  espn.routes[PL] = board(ev(1, 0));
  await assert.doesNotReject(() => feed.tick());
  assert.equal(feed.overlayOf('tsdb:1').score.home, 1);
});

test('tab tersembunyi: tidak bertanya kecuali hiddenOk (mis. ada laga yang diikuti)', async () => {
  const a = rig({ visible: () => false });
  assert.deepEqual(await a.feed.tick(), { skipped: 'hidden' });
  assert.equal(a.espn.calls.length, 0);
  const b = rig({ visible: () => false, hiddenOk: () => true });
  const r = await b.feed.tick();
  assert.ok(r.polled >= 1, JSON.stringify(r));
  assert.ok(b.espn.calls.length >= 1);
});

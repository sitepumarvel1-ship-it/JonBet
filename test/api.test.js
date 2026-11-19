import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { SPORTS } from '../server/sports.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

test('GET /api/health & /api/config', async () => {
  const h = await t.req('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  assert.equal(h.json.demo, true);
  const c = await t.req('GET', '/api/config');
  assert.equal(c.json.name, 'JonBet');
  assert.equal(c.json.sports.length, SPORTS.length);
  assert.equal(c.json.ai, 'builtin');
  assert.ok(c.json.disclaimer.length > 20);
  assert.equal(c.headers.get('cache-control'), 'no-store');
});

test('GET /api/matches: bentuk data, urutan, dan kelengkapan prakiraan', async () => {
  const r = await t.req('GET', '/api/matches');
  assert.equal(r.status, 200);
  const { matches, counts } = r.json;
  assert.ok(matches.length > 20, `hanya ${matches.length} laga`);
  const statuses = new Set(matches.map((m) => m.status));
  for (const s of ['live', 'upcoming', 'finished']) assert.ok(statuses.has(s), `tidak ada laga ${s}`);
  const ids = new Set();
  for (const m of matches) {
    assert.match(m.id, /^demo:[a-z]+-\d+-\d+$/);
    assert.ok(!ids.has(m.id), 'id ganda ' + m.id); ids.add(m.id);
    assert.notEqual(m.home.name, m.away.name);
    assert.ok(Number.isFinite(Date.parse(m.kickoff)));
    assert.ok(m.forecast, `forecast hilang untuk ${m.id}`);
    const f = m.forecast;
    assert.ok(Math.abs(f.home + f.draw + f.away - 1) < 1e-6, 'jumlah peluang tidak 1');
    if (m.status === 'live') assert.ok(m.score && Number.isInteger(m.score.home), 'laga live tanpa skor');
  }
  const live = SPORTS.filter((s) => counts[s.id]?.live).length;
  assert.ok(live >= 2, `hanya ${live} cabang yang punya laga live`); // data demo bergantung jam: pada beberapa jam hanya 2 cabang yang sedang live
});

test('filter: sport, status, q, from/to, limit', async () => {
  const fb = await t.req('GET', '/api/matches?sport=football');
  assert.ok(fb.json.matches.length > 0 && fb.json.matches.every((m) => m.sport === 'football'));
  const live = await t.req('GET', '/api/matches?status=live');
  assert.ok(live.json.matches.every((m) => m.status === 'live'));
  const lim = await t.req('GET', '/api/matches?limit=3');
  assert.equal(lim.json.matches.length, 3);
  const name = fb.json.matches[0].home.name;
  const q = await t.req('GET', `/api/matches?q=${encodeURIComponent(name.toLowerCase())}`);
  assert.ok(q.json.matches.length > 0 && q.json.matches.every((m) => (m.home.name + m.away.name + m.league).toLowerCase().includes(name.toLowerCase())));
  const none = await t.req('GET', '/api/matches?q=zzzxxyy');
  assert.equal(none.json.matches.length, 0);
  const now = t.clock.t;
  const win = await t.req('GET', `/api/matches?from=${now}&to=${now + 3600_000}`);
  assert.equal(win.status, 200);
  for (const m of win.json.matches) { const k = Date.parse(m.kickoff); assert.ok(k >= now - 4 * 3600_000 && k <= now + 3600_000 + 1000); }
});

test('parameter tidak valid ditolak dengan 400 yang rapi', async () => {
  for (const path of [
    '/api/matches?sport=catur', '/api/matches?status=aneh', '/api/matches?limit=0', '/api/matches?limit=9999', '/api/matches?limit=abc',
    '/api/matches?from=kemarin', '/api/matches?from=2026-01-01&to=2025-01-01', '/api/matches?from=2026-01-01&to=2026-03-01',
    '/api/feed?sport=catur', '/api/feed?limit=-1', '/api/model/record?sport=catur', '/api/leaderboard?limit=1000',
  ]) {
    const r = await t.req('GET', path);
    assert.equal(r.status, 400, `${path} -> ${r.status}`);
    assert.ok(r.json?.error?.message, path);
  }
});

test('detail laga & analisis lengkap untuk setiap cabang olahraga', async () => {
  for (const s of SPORTS) {
    const m = await t.firstMatch('upcoming', s.id);
    const d = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}`);
    assert.equal(d.status, 200, s.id);
    assert.equal(d.json.match.id, m.id);
    const a = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/analysis`);
    assert.equal(a.status, 200, `${s.id}: ${a.text.slice(0, 200)}`);
    const { analysis, form, h2h, summary, match } = a.json;
    assert.ok(analysis && form && h2h && summary && match, s.id);
    const p = analysis.pre.probs;
    assert.ok(Math.abs(p.home + p.away + (s.drawable ? p.draw : 0) - 1) < 1e-6, s.id);
    assert.ok(typeof summary.headline === 'string' && summary.headline.length > 5, s.id);
    assert.ok(Array.isArray(form.home.matches) && Array.isArray(h2h.matches));
    assert.doesNotMatch(JSON.stringify(a.json), /NaN|undefined|Infinity/, s.id);
  }
});

test('analisis laga live berisi peluang live dan terus berubah dengan waktu', async () => {
  const live = await t.req('GET', '/api/matches?status=live');
  assert.ok(live.json.matches.length > 0);
  for (const m of live.json.matches.slice(0, 6)) {
    const a = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/analysis`);
    assert.equal(a.status, 200);
    assert.ok(a.json.analysis.current, m.id);
    assert.doesNotMatch(a.text, /NaN|Infinity/);
  }
});

test('laga tidak ada / id aneh -> 404, bukan 500', async () => {
  for (const id of ['demo:zzz-1-1', 'demo:lnp-999999999-1', 'tsdb:123', 'x', '..%2F..%2Fetc%2Fpasswd', 'demo:%00', 'demo:' + 'a'.repeat(80), '%E0%A4%A', 'demo:lnp--5-0', 'demo:lnp-1e9-0']) {
    const r = await t.req('GET', `/api/matches/${id}`);
    assert.ok([404, 400].includes(r.status), `${id} -> ${r.status} ${r.text.slice(0, 80)}`);
    assert.notEqual(r.status, 500);
  }
});

test('GET /api/model/record: ada rekam jejak backtest berlabel simulasi', async () => {
  const r = await t.req('GET', '/api/model/record');
  assert.equal(r.status, 200);
  assert.equal(r.json.demo, true);
  assert.ok(r.json.backtest.n > 200);
  assert.ok(r.json.backtest.accuracy > 0.4 && r.json.backtest.accuracy < 0.95);
  const fb = await t.req('GET', '/api/model/record?sport=football');
  assert.equal(fb.status, 200);
});

test('model belajar: rating Elo memuat hasil riwayat dan memengaruhi analisis', async () => {
  const m = await t.firstMatch('upcoming', 'football');
  const a = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/analysis`);
  assert.ok(a.json.analysis.confidence.games > 3, 'seharusnya sudah belajar dari riwayat');
  assert.ok(a.json.ratings, 'ratings ada');
});

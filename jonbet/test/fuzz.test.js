import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { analyze } from '../server/model/model.js';
import { SPORTS } from '../server/sports.js';
import { mulberry } from './rng.js';

const R = mulberry(20261118);
const pick = (a) => a[Math.floor(R() * a.length)];
const int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));

test('fuzz model: ribuan kombinasi rating/skor/progres tidak pernah menghasilkan peluang tak valid', () => {
  for (let i = 0; i < 4000; i++) {
    const s = pick(SPORTS);
    const status = pick(['upcoming', 'live', 'live', 'finished']);
    const big = s.model === 'points' ? 200 : s.model === 'versus' ? 4 : 12;
    const a = analyze({
      sport: s.id,
      match: { status, score: R() < 0.1 ? null : { home: int(0, big), away: int(0, big) }, progress: R() < 0.2 ? undefined : R() * 1.2, minute: int(0, 130) },
      homeStats: { rating: int(700, 2500), games: int(0, 400), gf: int(0, 900), ga: int(0, 900) },
      awayStats: { rating: int(700, 2500), games: int(0, 400), gf: int(0, 900), ga: int(0, 900) },
    });
    for (const blk of [a.pre, a.current]) {
      const p = blk.probs;
      const sum = p.home + p.away + (s.drawable ? p.draw : 0);
      assert.ok(Math.abs(sum - 1) < 1e-6, `${s.id} jumlah ${sum}`);
      for (const v of [p.home, p.away]) assert.ok(v >= 0 && v <= 1 && Number.isFinite(v));
      if (blk.topScores) for (const t of blk.topScores) assert.ok(Number.isFinite(t.p) && t.p >= 0 && t.p <= 1);
      if (blk.totals) for (const t of blk.totals) assert.ok(t.over >= -1e-9 && t.over <= 1 + 1e-9, `${s.id} over ${t.over}`);
    }
    assert.doesNotMatch(JSON.stringify(a), /null.*NaN|NaN|Infinity/);
  }
});

const PATHS = ['/api/matches', '/api/feed', '/api/leaderboard', '/api/config', '/api/health', '/api/model/record', '/api/me', '/', '/js/main.js', '/api/users/abc', '/api/matches/demo:lnp-1-0'];
const JUNK = ['', '%', '%00', '%ff', '..', '../..', '<script>', "'", '"', '\\', 'a'.repeat(300), '-1', '0', '1e999', 'NaN', 'null', '[]', '{}', '🙂', '%E0%A4%A', ';', '&&', '?', '#'];
const BODIES = [undefined, '', '{}', '[]', 'null', '{"pick":', '{"pick":"H","confidence":"abc"}', '{"message":"x"}', '{"username":{},"password":[]}', '"string"', '12345', '{"pick":"H","confidence":1e999}', '\u0000'];

test('fuzz HTTP: 600 permintaan acak tidak pernah menghasilkan 5xx, dan server tetap hidup', async () => {
  const logs = [];
  const t = await boot({ log: (...a) => logs.push(a.join(' ')) });
  try {
    const u = await t.signup();
    const m = (await t.req('GET', '/api/matches?status=upcoming')).json.matches[0];
    let n5 = 0;
    for (let i = 0; i < 600; i++) {
      const base = pick(PATHS);
      const mutate = R();
      let path = base;
      if (mutate < 0.5) path += (base.includes('?') ? '&' : '?') + `${pick(['q', 'sport', 'status', 'from', 'to', 'limit', 'offset', 'sort', 'period', 'tab'])}=${pick(JUNK)}`;
      else if (mutate < 0.7) path = base + pick(JUNK);
      else if (mutate < 0.8) path = `/api/matches/${pick(JUNK)}${pick(['', '/analysis', '/ai', '/community', '/predictions'])}`;
      const method = pick(['GET', 'GET', 'GET', 'POST', 'DELETE', 'PUT', 'HEAD', 'OPTIONS', 'PATCH']);
      const useMatch = R() < 0.3 ? `/api/matches/${encodeURIComponent(m.id)}/${pick(['predictions', 'ai', 'analysis'])}` : path;
      const raw = pick(BODIES);
      let r;
      try {
        r = await t.req(method, useMatch, { raw, cookie: R() < 0.5 ? u.cookie : undefined, headers: { 'content-type': pick(['application/json', 'text/plain', 'application/json; charset=utf-8']) } });
      } catch (e) { r = { status: 0, text: String(e) }; }
      if (r.status >= 500) { n5++; assert.fail(`5xx (${r.status}) untuk ${method} ${useMatch} body=${JSON.stringify(raw)}: ${r.text.slice(0, 160)}`); }
      assert.doesNotMatch(r.text || '', /at .+\.js:\d+:\d+/, 'jejak tumpukan bocor');
    }
    assert.equal(n5, 0);
    assert.equal((await t.req('GET', '/api/health')).status, 200);
    const unexpected = logs.filter((l) => /galat tak terduga/.test(l));
    assert.equal(unexpected.length, 0, unexpected.slice(0, 2).join('\n'));
  } finally { await t.close(); }
});

test('rendam: 12 hari waktu simulasi, ratusan pengguna & tebakan; invarian poin dan tanpa galat internal', async () => {
  const logs = [];
  const t = await boot({ log: (...a) => logs.push(a.join(' ')) });
  try {
    const users = [];
    for (let i = 0; i < 25; i++) users.push(await t.signup(`rendam_${i}`));
    const start = t.clock.t;
    const made = new Map(); // matchId -> [userIdx]
    for (let step = 0; step < 12 * 24 * 2; step++) { // tiap 30 menit
      t.clock.t = start + step * 30 * 60_000;
      await t.app.service.tick();
      if (step % 4 === 0) {
        const ups = (await t.req('GET', '/api/matches?status=upcoming')).json.matches;
        for (let k = 0; k < 6 && ups.length; k++) {
          const m = pick(ups); const u = users[int(0, users.length - 1)];
          const s = SPORTS.find((x) => x.id === m.sport);
          const body = { pick: pick(s.drawable ? ['H', 'D', 'A'] : ['H', 'A']), confidence: int(1, 5) };
          const r = await t.req('POST', `/api/matches/${encodeURIComponent(m.id)}/predictions`, { body, cookie: u.cookie });
          assert.ok([200, 201, 409].includes(r.status), `${r.status} ${r.text}`);
        }
        const any = (await t.req('GET', '/api/matches')).json.matches;
        for (const mm of any.slice(0, 5)) assert.equal((await t.req('GET', `/api/matches/${encodeURIComponent(mm.id)}/analysis`)).status, 200);
      }
    }
    // invarian
    const db = t.app.db;
    const total = db.prepare("SELECT COUNT(*) n FROM predictions").get().n;
    assert.ok(total > 100, `hanya ${total} tebakan`);
    const bad = db.prepare("SELECT COUNT(*) n FROM predictions WHERE status IN ('won','lost') AND points IS NULL").get().n;
    assert.equal(bad, 0);
    const dupPicks = db.prepare("SELECT match_id, src, kind, COUNT(*) c FROM model_picks WHERE kind = 'backtest' GROUP BY match_id, src, kind HAVING c > 1").all();
    assert.equal(dupPicks.length, 0, 'backtest ganda: ' + JSON.stringify(dupPicks.slice(0, 2)));
    const lb = (await t.req('GET', '/api/leaderboard?period=all&limit=100')).json.rows;
    const dbSum = db.prepare("SELECT SUM(points) s FROM predictions WHERE status IN ('won','lost')").get().s || 0;
    assert.equal(lb.reduce((a, r) => a + r.points, 0), dbSum, 'jumlah poin papan peringkat = jumlah poin tebakan');
    const won = db.prepare("SELECT confidence, points FROM predictions WHERE status = 'won'").all();
    for (const w of won) assert.ok([10 + 2 * w.confidence, 20 + 2 * w.confidence].includes(w.points), `poin menang ${w.points} untuk keyakinan ${w.confidence}`);
    const lost = db.prepare("SELECT confidence, points FROM predictions WHERE status = 'lost'").all();
    for (const l of lost) assert.equal(l.points, -l.confidence);
    const pending = db.prepare("SELECT COUNT(*) n FROM predictions WHERE status = 'pending' AND kickoff_at < ?").get(t.clock.t - 6 * 3600_000).n;
    assert.equal(pending, 0, 'tebakan lama tidak boleh tertinggal berstatus menunggu');
    const rec = (await t.req('GET', '/api/model/record')).json;
    assert.ok(rec.backtest.n > 500);
    assert.equal(logs.filter((l) => /galat tak terduga|tick:/.test(l)).length, 0, logs.slice(0, 3).join('\n'));
  } finally { await t.close(); }
});

test('beban: 400 permintaan paralel campuran selesai cepat dan semuanya benar', async () => {
  const t = await boot();
  try {
    const m = (await t.req('GET', '/api/matches?status=live')).json.matches[0];
    const t0 = Date.now();
    const reqs = Array.from({ length: 400 }, (_, i) => {
      const k = i % 5;
      if (k === 0) return t.req('GET', '/api/matches');
      if (k === 1) return t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/analysis`);
      if (k === 2) return t.req('POST', `/api/matches/${encodeURIComponent(m.id)}/ai`, { body: { message: 'Siapa menang?' } });
      if (k === 3) return t.req('GET', '/api/feed');
      return t.req('GET', '/css/app.css');
    });
    const res = await Promise.all(reqs);
    assert.ok(res.every((r) => r.status === 200), res.filter((r) => r.status !== 200).slice(0, 2).map((r) => r.status + r.text).join());
    assert.ok(Date.now() - t0 < 15000, `lambat: ${Date.now() - t0}ms`);
  } finally { await t.close(); }
});

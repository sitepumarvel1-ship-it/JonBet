import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, eloExpected, eloUpdate, scoreMatrix, solveSetProb, pickOf, INITIAL_ELO } from '../server/model/model.js';
import { SPORTS } from '../server/sports.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const sumProbs = (p, drawable) => p.home + p.away + (drawable ? p.draw : 0);

test('eloExpected: simetris, 0.5 saat sama kuat, monoton', () => {
  close(eloExpected(0), 0.5);
  close(eloExpected(120) + eloExpected(-120), 1);
  assert.ok(eloExpected(200) > eloExpected(100));
  assert.ok(eloExpected(-400) > 0 && eloExpected(400) < 1);
});

test('eloUpdate: jumlah nol, pemenang naik, tidak bisa NaN', () => {
  for (const s of SPORTS) {
    const r = eloUpdate(s.id, 1500, 1500, s.model === 'versus' ? 2 : 3, s.model === 'versus' ? 1 : 1);
    assert.ok(Number.isFinite(r.home) && Number.isFinite(r.away), s.id);
    close(r.home + r.away, 3000, 1e-6);
    assert.ok(r.home > 1500 && r.away < 1500, `${s.id}: pemenang harus naik`);
  }
});

test('eloUpdate: kekalahan sebagai favorit berat dihukum lebih besar daripada menang tipis', () => {
  const upset = eloUpdate('football', 1700, 1400, 0, 1);
  const narrow = eloUpdate('football', 1700, 1400, 1, 0);
  assert.ok(1700 - upset.home > narrow.home - 1700);
});

test('eloUpdate: skor besar tidak membengkakkan rating tak terbatas', () => {
  for (const s of SPORTS.filter((x) => x.model !== 'versus')) {
    const big = eloUpdate(s.id, 1500, 1500, 200, 0);
    assert.ok(big.home - 1500 < 80, `${s.id} naik ${big.home - 1500}`);
  }
});

test('scoreMatrix: jumlah ~1 dan tidak negatif', () => {
  for (const [lh, la] of [[0.3, 0.3], [1.4, 1.1], [3.2, 0.4], [5, 5]]) {
    const m = scoreMatrix(lh, la);
    let sum = 0;
    for (const row of m) for (const v of row) { assert.ok(v >= 0); sum += v; }
    assert.ok(sum > 0.995 && sum < 1.005, `sum=${sum}`);
  }
});

test('solveSetProb: menghasilkan peluang set yang konsisten dengan peluang laga', () => {
  for (const k of [1, 2, 3]) {
    for (const target of [0.2, 0.5, 0.73, 0.95]) {
      const ps = solveSetProb(target, k);
      assert.ok(ps > 0 && ps < 1);
      if (target === 0.5) close(ps, 0.5, 1e-6);
    }
    assert.ok(solveSetProb(0.8, k) > solveSetProb(0.6, k));
  }
});

test('pickOf: memilih peluang tertinggi dan tidak pernah memilih seri bila tidak boleh', () => {
  assert.deepEqual(pickOf({ home: 0.2, draw: 0.5, away: 0.3 }, true).side, 'D');
  assert.equal(pickOf({ home: 0.2, draw: 0.5, away: 0.3 }, false).side, 'A');
  assert.equal(pickOf({ home: 0.6, draw: 0, away: 0.4 }, false).side, 'H');
});

for (const s of SPORTS) {
  test(`analyze ${s.id}: pra-laga valid (jumlah 1, rentang, keyakinan terhingga)`, () => {
    for (const [hr, ar] of [[INITIAL_ELO, INITIAL_ELO], [1800, 1300], [1300, 1800], [2200, 900]]) {
      const a = analyze({
        sport: s.id, match: { status: 'upcoming' },
        homeStats: { rating: hr, games: 20, gf: 30, ga: 25 }, awayStats: { rating: ar, games: 20, gf: 25, ga: 30 },
      });
      const p = a.pre.probs;
      close(sumProbs(p, s.drawable), 1, 1e-6);
      for (const v of s.drawable ? [p.home, p.draw, p.away] : [p.home, p.away]) assert.ok(v >= 0 && v <= 1 && Number.isFinite(v), `${s.id} ${v}`);
      if (!s.drawable) assert.ok(!p.draw, `${s.id}: tak boleh ada peluang seri`);
      assert.ok(Number.isFinite(a.confidence.score) && a.confidence.score >= 0 && a.confidence.score <= 100, `${s.id} keyakinan ${a.confidence.score}`);
      assert.equal(a.live, null);
      assert.ok(['H', 'A', 'D'].includes(a.pick.side));
      if (hr > ar + 200) assert.ok(p.home > p.away, `${s.id}: tim lebih kuat harus lebih diunggulkan`);
      if (hr < ar - 200) assert.ok(p.home < p.away || s.homeAdv > 300, s.id);
    }
  });

  test(`analyze ${s.id}: peluang awal tanpa data tetap wajar (tak ekstrem)`, () => {
    const a = analyze({ sport: s.id, match: { status: 'upcoming' } });
    assert.ok(a.pre.probs.home < 0.8 && a.pre.probs.away < 0.8, `${s.id} ${JSON.stringify(a.pre.probs)}`);
    assert.ok(a.confidence.score < 45, `${s.id}: tanpa data, keyakinan harus rendah (${a.confidence.score})`);
  });
}

test('live: tim yang unggul besar menjelang akhir hampir pasti menang', () => {
  for (const s of SPORTS.filter((x) => x.model === 'poisson' || x.model === 'points')) {
    const big = s.model === 'poisson' ? 3 : 40;
    const a = analyze({
      sport: s.id,
      match: { status: 'live', score: { home: big, away: 0 }, progress: 0.9, minute: Math.round(s.duration * 0.9) },
      homeStats: { rating: 1500, games: 20 }, awayStats: { rating: 1500, games: 20 },
    });
    assert.ok(a.live, s.id);
    assert.ok(a.current.probs.home > 0.9, `${s.id}: ${a.current.probs.home}`);
    close(sumProbs(a.current.probs, s.drawable), 1, 1e-6);
  }
});

test('live: skor seri di akhir waktu membuat peluang seri membesar (sepak bola)', () => {
  const early = analyze({ sport: 'football', match: { status: 'live', score: { home: 1, away: 1 }, progress: 0.1 } });
  const late = analyze({ sport: 'football', match: { status: 'live', score: { home: 1, away: 1 }, progress: 0.95 } });
  assert.ok(late.current.probs.draw > early.current.probs.draw);
});

test('live: tennis memakai hitungan set dan abaikan skor yang tak masuk akal', () => {
  const ok = analyze({ sport: 'tennis', match: { status: 'live', score: { home: 1, away: 0 }, progress: 0.4 } });
  assert.ok(ok.current.probs.home > ok.pre.probs.home);
  const weird = analyze({ sport: 'tennis', match: { status: 'live', score: { home: 6, away: 4 }, progress: 0.4 } });
  assert.equal(weird.live, null);
});

test('analyze: masukan jelek tidak membuat NaN atau melempar galat', () => {
  const junk = [undefined, null, {}, { score: { home: 'x', away: null } }, { status: 'live' }, { status: 'live', score: { home: -3, away: 1e9 }, progress: 7 }];
  for (const s of SPORTS) {
    for (const m of junk) {
      const a = analyze({ sport: s.id, match: m, homeStats: { rating: NaN, games: -4 }, awayStats: null });
      const p = a.current.probs;
      for (const v of [p.home, p.away]) assert.ok(Number.isFinite(v), `${s.id} ${JSON.stringify(m)}`);
    }
  }
  assert.throws(() => analyze({ sport: 'catur', match: {} }));
});

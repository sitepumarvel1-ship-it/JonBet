// Model prediksi JonBet.
//
// Tiga keluarga model, semuanya dibangun dari rating Elo yang belajar sendiri dari hasil
// pertandingan yang pernah dilihat server:
//   poisson : skor gol ~ Poisson dengan koreksi Dixon-Coles untuk skor rendah
//   points  : selisih poin ~ distribusi normal
//   versus  : peluang menang per set/ronde dicari dari peluang Elo, lalu dihitung hingga skor set
//
// Semua keluaran adalah PELUANG, bukan kepastian, dan tidak memuat odds atau taruhan.

import { SPORTS_BY_ID } from '../sports.js';
import { clamp, normalCdf, num } from '../util.js';

export const INITIAL_ELO = 1500;
export const MODEL_VERSION = 'jonbet-elo-1.0';

/** Peluang menang (skor harapan) untuk pihak dengan keunggulan rating `diff`. */
export function eloExpected(diff) {
  return 1 / (1 + Math.pow(10, -diff / 400));
}

/** Pembaruan Elo setelah pertandingan selesai. */
export function eloUpdate(sportId, ratingHome, ratingAway, hs, as) {
  const cfg = SPORTS_BY_ID[sportId];
  const diff = ratingHome + cfg.homeAdv - ratingAway;
  const expected = eloExpected(diff);
  const actual = hs > as ? 1 : hs < as ? 0 : 0.5;
  // Selisih skor dinormalkan ke "satuan tipikal" cabang itu supaya cabang berskor tinggi tidak membengkakkan rating.
  const unit = cfg.model === 'poisson' ? cfg.baseTotal / 2.7 : cfg.model === 'points' ? cfg.sd / 4 : 1;
  const margin = Math.abs(hs - as) / unit;
  const mult = cfg.model === 'versus' ? 1 : 1 + 0.5 * Math.log1p(margin);
  const delta = cfg.k * mult * (actual - expected);
  return { home: ratingHome + delta, away: ratingAway - delta, delta, expected };
}

/* ---------------------------------------------------------------- Poisson */

function poissonPmf(lambda, n) {
  const out = [Math.exp(-lambda)];
  for (let i = 1; i <= n; i++) out.push((out[i - 1] * lambda) / i);
  return out;
}

function dcTau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

/** Matriks peluang skor tambahan [i][j] (gol tim tuan rumah i, tamu j). */
export function scoreMatrix(lh, la, N = 14, rho = -0.07) {
  const ph = poissonPmf(lh, N);
  const pa = poissonPmf(la, N);
  const m = [];
  let sum = 0;
  for (let i = 0; i <= N; i++) {
    m.push([]);
    for (let j = 0; j <= N; j++) {
      let p = ph[i] * pa[j];
      if (i < 2 && j < 2) p *= dcTau(i, j, lh, la, rho);
      m[i].push(p);
      sum += p;
    }
  }
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) m[i][j] /= sum;
  return m;
}

function blendTotal(cfg, hs, as) {
  const g = Math.min(hs.games, as.games);
  if (g < 3) return cfg.baseTotal;
  const obsH = (hs.gf + hs.ga) / hs.games;
  const obsA = (as.gf + as.ga) / as.games;
  const obs = (obsH + obsA) / 2;
  const w = Math.min(0.6, g / (g + 10));
  return (1 - w) * cfg.baseTotal + w * obs;
}

function summarizeBins(dist, bands, drawable) {
  // dist: Map selisih(home-away) -> peluang. Bin: home >b1, b0+1..b1, 1..b0, seri, away ...
  const [b0, b1] = bands;
  const sum = (pred) => { let s = 0; for (const [d, p] of dist) if (pred(d)) s += p; return s; };
  const bins = [
    { side: 'home', from: b1 + 1, to: null, p: sum((d) => d >= b1 + 1) },
    { side: 'home', from: b0 + 1, to: b1, p: sum((d) => d >= b0 + 1 && d <= b1) },
    { side: 'home', from: 1, to: b0, p: sum((d) => d >= 1 && d <= b0) },
  ];
  if (drawable) bins.push({ side: 'draw', from: 0, to: 0, p: sum((d) => d === 0) });
  bins.push(
    { side: 'away', from: 1, to: b0, p: sum((d) => d <= -1 && d >= -b0) },
    { side: 'away', from: b0 + 1, to: b1, p: sum((d) => d <= -(b0 + 1) && d >= -b1) },
    { side: 'away', from: b1 + 1, to: null, p: sum((d) => d <= -(b1 + 1)) },
  );
  return bins;
}

function poissonModel(cfg, dElo, hs, as, live) {
  const T = blendTotal(cfg, hs, as);
  const s = dElo / cfg.eloScale;
  const lamH = (T / 2) * Math.exp(s);
  const lamA = (T / 2) * Math.exp(-s);

  const f = live ? live.f : 1;
  const base = live ? live.score : { home: 0, away: 0 };
  const m = scoreMatrix(lamH * f, lamA * f);

  let pH = 0, pD = 0, pA = 0, btts = 0;
  const diffDist = new Map();
  const totalDist = new Map();
  const finals = [];
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      const p = m[i][j];
      const h = base.home + i;
      const a = base.away + j;
      if (h > a) pH += p; else if (h < a) pA += p; else pD += p;
      if (h > 0 && a > 0) btts += p;
      diffDist.set(h - a, (diffDist.get(h - a) || 0) + p);
      totalDist.set(h + a, (totalDist.get(h + a) || 0) + p);
      finals.push({ h, a, p });
    }
  }

  // Olahraga tanpa seri (mis. hoki es): seri reguler dibagi menurut keunggulan relatif (perpanjangan waktu).
  let probs;
  if (cfg.drawable) probs = { home: pH, draw: pD, away: pA };
  else {
    const share = pH + pA > 0 ? pH / (pH + pA) : 0.5;
    probs = { home: pH + pD * share, draw: 0, away: pA + pD * (1 - share) };
  }

  const totals = cfg.totalLines.map((line) => {
    let over = 0;
    for (const [t, p] of totalDist) if (t > line) over += p;
    return { line, over, under: 1 - over };
  });

  const topScores = finals.sort((x, y) => y.p - x.p).slice(0, 6).map((x) => ({ home: x.h, away: x.a, p: x.p }));

  // Matriks tampilan 0..6 (skor akhir), nilai mentah.
  const D = 7;
  const matrix = Array.from({ length: D }, () => Array(D).fill(0));
  for (const { h, a, p } of finals) if (h < D && a < D) matrix[h][a] += p;

  return {
    model: 'poisson',
    probs,
    expected: {
      home: base.home + lamH * f,
      away: base.away + lamA * f,
      total: base.home + base.away + (lamH + lamA) * f,
    },
    totals,
    btts: cfg.btts ? { yes: btts, no: 1 - btts } : null,
    topScores,
    matrix,
    margins: summarizeBins(diffDist, cfg.bands || [1, 2], cfg.drawable),
    params: { lambdaHome: lamH, lambdaAway: lamA, baseTotal: T },
  };
}

/* ----------------------------------------------------------------- Points */

function pointsModel(cfg, dElo, hs, as, live) {
  const T = blendTotal(cfg, hs, as);
  const mu = dElo * cfg.eloToMargin;
  const sd = cfg.sd;
  const sdTotal = sd * 1.4;
  const f = live ? live.f : 1;
  const cur = live ? live.score : { home: 0, away: 0 };

  const meanDiff = cur.home - cur.away + mu * f;
  const meanTotal = cur.home + cur.away + T * f;
  const sdDiff = Math.max(sd * Math.sqrt(f), 1e-6);
  const sdTot = Math.max(sdTotal * Math.sqrt(f), 1e-6);

  const cdfDiff = (x) => normalCdf(x, meanDiff, sdDiff);
  let pH = 1 - cdfDiff(0.5);
  let pA = cdfDiff(-0.5);
  const tie = Math.max(0, 1 - pH - pA);
  const share = pH + pA > 0 ? pH / (pH + pA) : 0.5;
  pH += tie * share;
  pA += tie * (1 - share);

  const [b0, b1] = cfg.bands;
  const bin = (lo, hi) => Math.max(0, cdfDiff(hi) - cdfDiff(lo));
  const margins = [
    { side: 'home', from: b1 + 1, to: null, p: 1 - cdfDiff(b1 + 0.5) },
    { side: 'home', from: b0 + 1, to: b1, p: bin(b0 + 0.5, b1 + 0.5) },
    { side: 'home', from: 1, to: b0, p: bin(0.5, b0 + 0.5) },
    { side: 'away', from: 1, to: b0, p: bin(-b0 - 0.5, -0.5) },
    { side: 'away', from: b0 + 1, to: b1, p: bin(-b1 - 0.5, -b0 - 0.5) },
    { side: 'away', from: b1 + 1, to: null, p: cdfDiff(-b1 - 0.5) },
  ];

  const step = cfg.totalStep;
  const center = Math.round(meanTotal / step) * step;
  const totals = [-2, -1, 0, 1, 2].map((k) => {
    const line = center + k * step + 0.5;
    const over = 1 - normalCdf(line, meanTotal, sdTot);
    return { line, over, under: 1 - over };
  });

  return {
    model: 'points',
    probs: { home: pH, draw: 0, away: pA },
    expected: {
      home: (meanTotal + meanDiff) / 2,
      away: (meanTotal - meanDiff) / 2,
      total: meanTotal,
      margin: meanDiff,
    },
    totals,
    btts: null,
    topScores: [],
    matrix: null,
    margins,
    params: { margin: mu, sd, baseTotal: T },
  };
}

/* ----------------------------------------------------------------- Versus */

const winsNeeded = (bestOf) => Math.ceil(bestOf / 2);

function winProb(ps, k, sh, sa, memo = new Map()) {
  if (sh >= k) return 1;
  if (sa >= k) return 0;
  const key = sh * 16 + sa;
  if (memo.has(key)) return memo.get(key);
  const v = ps * winProb(ps, k, sh + 1, sa, memo) + (1 - ps) * winProb(ps, k, sh, sa + 1, memo);
  memo.set(key, v);
  return v;
}

/** Cari peluang menang per set `ps` sehingga peluang menang pertandingan = p. */
export function solveSetProb(p, k) {
  if (k <= 1) return clamp(p, 0.001, 0.999);
  let lo = 0.0005;
  let hi = 0.9995;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (winProb(mid, k, 0, 0) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function finalSetDist(ps, k, sh, sa) {
  const out = new Map();
  (function walk(h, a, p) {
    if (h >= k || a >= k) {
      const key = `${h}-${a}`;
      out.set(key, (out.get(key) || 0) + p);
      return;
    }
    walk(h + 1, a, p * ps);
    walk(h, a + 1, p * (1 - ps));
  })(sh, sa, 1);
  return out;
}

function versusModel(cfg, dElo, live) {
  const pMatch = eloExpected(dElo);
  const k = winsNeeded(cfg.bestOf);
  const ps = solveSetProb(pMatch, k);
  const state = live && live.sets ? live.sets : { home: 0, away: 0 };
  const pHome = winProb(ps, k, state.home, state.away);

  let sets = null;
  let expected = null;
  if (cfg.bestOf > 1) {
    const dist = finalSetDist(ps, k, state.home, state.away);
    sets = [...dist.entries()].map(([score, p]) => ({ score, p })).sort((a, b) => b.p - a.p);
    let eh = 0, ea = 0;
    for (const [score, p] of dist) {
      const [h, a] = score.split('-').map(Number);
      eh += h * p;
      ea += a * p;
    }
    expected = { home: eh, away: ea, total: eh + ea };
  }

  return {
    model: 'versus',
    probs: { home: pHome, draw: 0, away: 1 - pHome },
    expected,
    totals: [],
    btts: null,
    topScores: [],
    matrix: null,
    margins: [],
    sets,
    params: { setProb: ps, bestOf: cfg.bestOf, winsNeeded: k },
  };
}

/* ------------------------------------------------------------ Orkestrasi */

const emptyStats = { rating: INITIAL_ELO, games: 0, gf: 0, ga: 0 };
const finiteOr = (v, d) => (Number.isFinite(v) ? v : d);
const normStats = (s) => {
  const x = { ...emptyStats, ...(s || {}) };
  return {
    ...x,
    rating: clamp(finiteOr(x.rating, INITIAL_ELO), 600, 2800),
    games: Math.max(0, finiteOr(x.games, 0)),
    gf: Math.max(0, finiteOr(x.gf, 0)),
    ga: Math.max(0, finiteOr(x.ga, 0)),
  };
};

function liveState(cfg, match) {
  if (match.status !== 'live' || !match.score) return null;
  const sc = { home: num(match.score.home), away: num(match.score.away) };
  let progress = match.progress;
  if (!Number.isFinite(progress) && Number.isFinite(match.minute) && cfg.model !== 'versus') {
    progress = match.minute / cfg.duration;
  }
  if (!Number.isFinite(progress)) progress = 0.5;
  const f = clamp(1 - progress, 0.01, 1);

  if (cfg.model === 'versus') {
    const k = winsNeeded(cfg.bestOf);
    // Skor dianggap hitungan set hanya jika masuk akal; kalau tidak, abaikan koreksi live.
    if (cfg.bestOf > 1 && sc.home <= k && sc.away <= k && !(sc.home === k && sc.away === k)) {
      return { score: sc, f, sets: sc, progress };
    }
    return null;
  }
  return { score: sc, f, progress };
}

function buildConfidence(cfg, probs, hs, as) {
  const games = Math.min(hs.games, as.games);
  const data = 1 - Math.exp(-games / 8);
  const top = Math.max(probs.home, probs.draw, probs.away);
  const clarity = cfg.drawable ? clamp((top - 1 / 3) / (2 / 3), 0, 1) : clamp((top - 0.5) / 0.5, 0, 1);
  const score = Math.round(100 * (0.6 * data + 0.4 * clarity));
  const label = score < 35 ? 'Rendah' : score < 60 ? 'Sedang' : 'Tinggi';
  const reasons = [];
  if (games < 5) reasons.push(`Riwayat data kedua tim masih sedikit (${games} pertandingan pada tim yang paling sedikit datanya).`);
  else if (games < 12) reasons.push(`Riwayat data cukup (${games} pertandingan), tapi belum banyak.`);
  else reasons.push(`Riwayat data memadai (${games}+ pertandingan untuk kedua tim).`);
  if (clarity < 0.2) reasons.push('Peluang kedua sisi hampir seimbang, jadi hasil sulit ditebak.');
  else if (clarity > 0.55) reasons.push('Ada selisih kekuatan yang jelas antara kedua sisi.');
  return { score, label, reasons, games };
}

/** Peluang pra-laga tidak pernah 0% atau 100%: selalu ada ruang untuk kejutan. */
function softClamp(probs, drawable, lo) {
  const keys = drawable ? ['home', 'draw', 'away'] : ['home', 'away'];
  const out = { ...probs };
  for (const k of keys) out[k] = Math.max(lo, out[k]);
  const sum = keys.reduce((a, k) => a + out[k], 0);
  for (const k of keys) out[k] /= sum;
  return out;
}

function runModel(cfg, dElo, hs, as, live) {
  const r = cfg.model === 'poisson' ? poissonModel(cfg, dElo, hs, as, live)
    : cfg.model === 'points' ? pointsModel(cfg, dElo, hs, as, live)
      : versusModel(cfg, dElo, live);
  r.probs = softClamp(r.probs, cfg.drawable, live ? 0.0005 : 0.015);
  return r;
}

export function pickOf(probs, drawable) {
  const entries = [['H', probs.home], ['A', probs.away]];
  if (drawable) entries.push(['D', probs.draw]);
  entries.sort((a, b) => b[1] - a[1]);
  return { side: entries[0][0], p: entries[0][1] };
}

/**
 * Analisis lengkap sebuah pertandingan.
 * @param {{sport:string, match:object, homeStats?:object, awayStats?:object}} args
 */
export function analyze({ sport, match, homeStats, awayStats }) {
  const cfg = SPORTS_BY_ID[sport];
  if (!cfg) throw new Error(`Cabang olahraga tidak dikenal: ${sport}`);
  const hs = normStats(homeStats);
  const as = normStats(awayStats);
  const dElo = hs.rating + cfg.homeAdv - as.rating;

  const pre = runModel(cfg, dElo, hs, as, null);
  const ls = liveState(cfg, match || {});
  const live = ls ? runModel(cfg, dElo, hs, as, ls) : null;
  const current = live || pre;

  return {
    version: MODEL_VERSION,
    sport,
    model: cfg.model,
    drawable: cfg.drawable,
    elo: { home: hs.rating, away: as.rating, homeAdv: cfg.homeAdv, diff: dElo },
    pre,
    live,
    current,
    pick: pickOf(pre.probs, cfg.drawable),
    confidence: buildConfidence(cfg, pre.probs, hs, as),
  };
}

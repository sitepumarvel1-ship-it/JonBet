// Fungsi bantu kecil tanpa dependensi.

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hash string -> uint32 (FNV-1a). */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** PRNG deterministik (mulberry32). */
export function rng(seed) {
  let a = (typeof seed === 'string' ? hash32(seed) : seed) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sampel normal standar via Box-Muller. */
export function gauss(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Sampel Poisson (algoritma Knuth, aman untuk lambda kecil-sedang). */
export function poissonSample(lambda, rand) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L && k < 100);
  return k - 1;
}

/** Fungsi galat (Abramowitz-Stegun 7.1.26), akurasi ~1.5e-7. */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (x, mean = 0, sd = 1) => 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));

/** Normalisasi nama tim -> kunci stabil (huruf kecil, tanpa aksen/tanda baca). */
export function teamKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Pembulatan persen yang jumlahnya tepat 100 (largest remainder). */
export function pct(values) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors;
}

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

export function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/** Hindari angka tak terhingga/NaN masuk ke JSON. */
export const num = (x, d = 0) => (Number.isFinite(x) ? x : d);

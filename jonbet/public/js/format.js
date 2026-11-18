const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
const fDay = new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
const fLong = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
const fShortDate = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });

export const timeZone = tz;
export const clock = (iso) => fTime.format(new Date(iso)).replace('.', ':');
export const dayLabel = (d) => fDay.format(d);
export const longWhen = (iso) => fLong.format(new Date(iso)).replace(/\./g, ':');
export const shortDate = (iso) => fShortDate.format(new Date(iso));

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

export function relative(iso) {
  const diff = Date.now() - Date.parse(iso);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} jam lalu`;
  return `${Math.round(hrs / 24)} hari lalu`;
}

export function untilKickoff(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'sebentar lagi';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} menit lagi`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs} jam ${m % 60} menit lagi`;
  return `${Math.floor(hrs / 24)} hari lagi`;
}

// Peluang tidak pernah ditampilkan sebagai "100%" atau "0%" selagi belum pasti.
export const pctInt = (x) => (x >= 0.995 && x < 1 ? '>99%' : x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
export const num1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');

/** Persen bulat dengan jumlah tepat 100 (largest remainder). */
export function pct3(values) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

export const initials = (name) => {
  const w = String(name).split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : w.slice(0, 2).map((x) => x[0]).join('')).toUpperCase();
};

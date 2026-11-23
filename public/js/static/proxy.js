// Sumber skor langsung kedua: proxy milik sendiri (Cloudflare Workers) di depan penyedia data berlisensi.
// Modul ini murni (tanpa DOM, tanpa jaringan): membaca JSON proxy, mencocokkan ke laga, dan membuat overlay.
// Bentuk JSON-nya didefinisikan di worker/live-proxy.js.
import { pickEvent } from './espn.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** URL proxy yang boleh dipakai: https, tanpa kredensial, host bertitik. Selain itu dianggap tidak diatur. */
export function cleanProxyUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** @returns {{label: string, at: number, stale: boolean, events: object[]}} (melempar bila bukan respons proxy yang sah) */
export function parseProxy(json) {
  if (!json || json.ok !== true || !Array.isArray(json.events)) throw new Error('Respons proxy tidak sah');
  const events = [];
  for (const e of json.events) {
    if (!e || typeof e !== 'object') continue;
    if (!e.home || !e.away || !Number.isInteger(e.hs) || !Number.isInteger(e.as)) continue;
    if (e.state !== 'in' && e.state !== 'post') continue;
    events.push({
      id: String(e.id ?? ''),
      sport: String(e.sport || ''),
      // bentuk yang sama dengan peristiwa ESPN supaya pencocokan nama (pickEvent) dipakai ulang
      date: Number.isFinite(e.kickoff) ? e.kickoff : null,
      home: { names: [String(e.home)], abbr: '', score: e.hs },
      away: { names: [String(e.away)], abbr: '', score: e.as },
      state: e.state,
      minute: Number.isFinite(e.minute) ? e.minute : null,
      period: String(e.period || ''),
      code: String(e.code || ''),
    });
  }
  return { label: String(json.label || json.provider || 'Proxy').slice(0, 30), at: Number.isFinite(json.at) ? json.at : 0, stale: json.stale === true, events };
}

/**
 * Overlay untuk satu laga dari daftar peristiwa proxy, atau null bila tidak ada yang cocok.
 * Hanya peristiwa dengan cabang yang sama yang dipertimbangkan, dan peristiwa tanpa jam mulai dianggap mulai pada jam laga di snapshot.
 */
export function overlayFromProxy(match, events) {
  const kick = Date.parse(match?.kickoff);
  if (!Number.isFinite(kick)) return null;
  const sameSport = events
    .filter((e) => e.sport === match.sport)
    .map((e) => (e.date === null ? { ...e, date: kick } : e));
  const hit = pickEvent({ ...match, espnId: null }, sameSport); // id proxy bukan id ESPN
  if (!hit) return null;
  const { ev, swapped } = hit;
  const hs = swapped ? ev.away.score : ev.home.score;
  const as = swapped ? ev.home.score : ev.away.score;
  const live = ev.state === 'in';
  let progress = null;
  if (!live) progress = 1;
  else if (match.sport === 'football') {
    if (ev.code === 'HT') progress = 0.5;
    else if (ev.code === 'PEN') progress = 0.99;
    else if (ev.minute !== null) progress = clamp(ev.minute / 90, 0, 0.99);
  }
  return {
    status: live ? 'live' : 'finished',
    score: { home: hs, away: as },
    minute: live ? ev.minute : null,
    period: ev.period || (live ? 'Live' : 'Selesai'),
    progress,
    espnId: null,
  };
}

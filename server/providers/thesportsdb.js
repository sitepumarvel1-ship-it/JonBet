// Penyedia data nyata dari TheSportsDB (https://www.thesportsdb.com).
//
// - Kunci gratis ("3") memberi jadwal/hasil per hari lewat eventsday.php (dengan batas permintaan).
// - Kunci premium membuka skor langsung (livescore v2). Tanpa itu, status "live" diperkirakan dari
//   jam kickoff dan data yang tersedia, dan bisa terlambat.
// Dokumentasi: https://www.thesportsdb.com/documentation  (data hasil kontribusi komunitas, wajib atribusi).

import { SPORTS, SPORTS_BY_TSDB } from '../sports.js';
import { addDays, isoDate } from '../util.js';

const FREE_KEYS = new Set(['1', '2', '3', '123']);

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

function parseKickoff(e) {
  const ts = e.strTimestamp;
  if (ts && /^\d{4}-\d{2}-\d{2}/.test(ts)) {
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  if (e.dateEvent) {
    const time = /^\d{2}:\d{2}(:\d{2})?$/.test(e.strTime || '') ? e.strTime : '00:00:00';
    const ms = Date.parse(`${e.dateEvent}T${time.length === 5 ? `${time}:00` : time}Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Terjemahkan status mentah TheSportsDB ke status JonBet. */
export function mapStatus(rawStatus, rawProgress, hasScore, kickoffMs, nowMs) {
  const s = String(rawStatus || '').trim().toLowerCase();
  const p = String(rawProgress || '').trim().toLowerCase();
  if (/postpon|ppd|delayed/.test(s)) return 'postponed';
  if (/cancel|abandon|walkover|w\.?o\.?|forfeit|suspend/.test(s)) return 'cancelled';
  if (/finish|^ft$|^aet$|^pen|after (extra|pen)|final|ended|^aot$|^ap$/.test(s)) return 'finished';
  if (/^(1h|2h|ht|q[1-4]|ot|live|in play|inplay|break|et|bt|p[1-3]|s[1-5]|i[1-9])$/.test(s) || /in progress|in play|half|quarter|period|inning|set \d|overtime|extra time|live/.test(s)) return 'live';
  if (/^\d+'?$/.test(p) || /^\d+\+?\d*'?$/.test(p)) return 'live';
  if (/not started|^ns$|scheduled|tbd|^tba$|^$/.test(s)) {
    if (kickoffMs && nowMs - kickoffMs > 6 * 3600_000 && hasScore) return 'finished';
    return 'upcoming';
  }
  return 'upcoming';
}

export function normalizeEvent(e, nowMs = Date.now()) {
  if (!e || typeof e !== 'object') return null;
  const sport = SPORTS_BY_TSDB[String(e.strSport || '').toLowerCase()];
  if (!sport || !e.idEvent || !e.strHomeTeam || !e.strAwayTeam) return null;
  const kickoff = parseKickoff(e);
  if (kickoff === null) return null;

  const hs = toInt(e.intHomeScore);
  const as = toInt(e.intAwayScore);
  const hasScore = hs !== null && as !== null;
  const status = mapStatus(e.strStatus, e.strProgress, hasScore, kickoff, nowMs);
  const minute = toInt(String(e.strProgress || '').replace(/[^\d]/g, '')) ?? null;

  const short = (name) => {
    const w = String(name).split(/\s+/).filter(Boolean);
    return (w.length === 1 ? w[0].slice(0, 3) : w.slice(0, 3).map((x) => x[0]).join('')).toUpperCase();
  };

  return {
    id: `tsdb:${e.idEvent}`,
    sport: sport.id,
    league: e.strLeague || 'Liga',
    leagueId: e.idLeague || null,
    home: { name: String(e.strHomeTeam), short: short(e.strHomeTeam), badge: safeUrl(e.strHomeTeamBadge) },
    away: { name: String(e.strAwayTeam), short: short(e.strAwayTeam), badge: safeUrl(e.strAwayTeamBadge) },
    kickoff: new Date(kickoff).toISOString(),
    status,
    minute: status === 'live' ? minute : null,
    period: status === 'finished' ? 'Selesai' : status === 'live' ? String(e.strProgress || e.strStatus || 'Live') : null,
    // Laga live: bagian waktu yang sudah lewat. Hanya sepak bola/futsal yang strProgress-nya berupa menit; untuk
    // cabang lain nilainya tidak diketahui (null), sehingga model memakai perkiraan tengah laga, bukan "baru mulai".
    progress: status === 'finished' ? 1
      : status === 'live' && minute !== null && (sport.id === 'football' || sport.id === 'futsal') ? Math.min(0.99, minute / sport.duration)
        : null,
    score: hasScore && status !== 'upcoming' ? { home: hs, away: as } : null,
    stats: null,
    events: [],
    venue: e.strVenue || null,
    source: 'thesportsdb',
  };
}

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createTsdbProvider({ key = '3', fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 8000, perMinute = 25 } = {}) {
  const base = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}`;
  const premium = !FREE_KEYS.has(String(key));
  const cache = new Map(); // url -> {at, data}
  const events = new Map(); // id -> match (terakhir dilihat)
  let windowStart = now();
  let used = 0;

  async function getJson(url, ttlMs, headers = {}) {
    const hit = cache.get(url);
    const t = now();
    if (hit && t - hit.at < ttlMs) return hit.data;

    if (t - windowStart > 60_000) { windowStart = t; used = 0; }
    if (used >= perMinute) {
      if (hit) return hit.data; // batas permintaan: pakai data lama
      throw new Error('Batas permintaan TheSportsDB tercapai, coba lagi sebentar.');
    }
    used++;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', ...headers } });
      if (!res.ok) throw new Error(`TheSportsDB membalas HTTP ${res.status}`);
      const data = await res.json();
      cache.set(url, { at: t, data });
      return data;
    } catch (err) {
      if (hit) return hit.data; // gagal jaringan: pakai data lama bila ada
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function dayEvents(date, sport, ttl) {
    const url = `${base}/eventsday.php?d=${date}&s=${encodeURIComponent(sport.tsdb)}`;
    const data = await getJson(url, ttl);
    return Array.isArray(data?.events) ? data.events : [];
  }

  async function liveOverlay(matches) {
    if (!premium) return;
    try {
      const data = await getJson('https://www.thesportsdb.com/api/v2/json/livescore/all', 15_000, { 'X-API-KEY': key });
      const rows = data?.livescore || data?.events || [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const m = matches.get(`tsdb:${r.idEvent}`);
        if (!m) continue;
        const hs = toInt(r.intHomeScore);
        const as = toInt(r.intAwayScore);
        const st = mapStatus(r.strStatus, r.strProgress, hs !== null && as !== null, Date.parse(m.kickoff), now());
        m.status = st === 'upcoming' ? 'live' : st;
        if (hs !== null && as !== null) m.score = { home: hs, away: as };
        m.minute = toInt(String(r.strProgress || '').replace(/[^\d]/g, ''));
        m.period = String(r.strProgress || r.strStatus || 'Live');
      }
    } catch { /* livescore bersifat opsional */ }
  }

  return {
    name: 'thesportsdb',
    isDemo: false,
    premium,

    async listMatches({ from, to, sports = null }) {
      const wanted = sports ? SPORTS.filter((s) => sports.includes(s.id)) : SPORTS;
      const dates = [];
      for (let d = new Date(isoDate(from)); d.getTime() <= to + 86400_000 && dates.length < 9; d = addDays(d, 1)) dates.push(isoDate(d));

      const today = isoDate(now());
      const jobs = [];
      for (const date of dates) for (const sport of wanted) jobs.push({ date, sport });

      const found = new Map();
      let firstError = null;
      let okCount = 0;
      // Konkurensi dibatasi agar tidak menabrak batas permintaan.
      const queue = [...jobs];
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) {
          const { date, sport } = queue.shift();
          try {
            const ttl = date === today ? 90_000 : 600_000;
            const rows = await dayEvents(date, sport, ttl);
            okCount++;
            for (const e of rows) {
              const m = normalizeEvent(e, now());
              if (m) found.set(m.id, m);
            }
          } catch (err) {
            firstError = firstError || err;
          }
        }
      }));

      if (okCount === 0 && firstError) throw firstError;
      await liveOverlay(found);
      for (const [id, m] of found) events.set(id, m);
      return [...found.values()].filter((m) => {
        const ko = Date.parse(m.kickoff);
        return ko >= from && ko <= to;
      });
    },

    async getMatch(id) {
      const raw = String(id).replace(/^tsdb:/, '');
      if (!/^\d{1,12}$/.test(raw)) return null;
      const url = `${base}/lookupevent.php?id=${raw}`;
      const data = await getJson(url, 60_000);
      const e = Array.isArray(data?.events) ? data.events[0] : null;
      const m = normalizeEvent(e, now());
      if (m) {
        const known = events.get(m.id);
        if (known && known.status === 'live' && m.status === 'upcoming') return known; // overlay live lebih baru
        events.set(m.id, m);
      }
      return m;
    },
  };
}

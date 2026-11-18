// Penyedia data nyata dari scoreboard publik ESPN (jadwal, hasil, dan status live), dipanggil dari server/build.
//
// Catatan jujur:
//  - API ini tidak resmi dan tidak berdokumen; ESPN bisa mengubah atau membatasinya kapan saja.
//  - Satu permintaan rentang tanggal per liga (?dates=YYYYMMDD-YYYYMMDD) sudah memuat seluruh jadwal dan hasil di rentang itu.
//  - Hanya liga di tabel ENDPOINTS (public/js/static/espn.js) yang dicoba. Slug yang tidak ada hanya mencatat satu liga gagal;
//    sisanya tetap diproses. Ringkasan per liga tersedia di `provider.report` dan dicatat oleh skrip build.
//  - Cabang yang tidak dicakup (tenis, MMA, rugby, esports, bulu tangkis, voli, futsal) dilayani sumber lain.

import { SPORTS_BY_ID } from '../sports.js';
import { ENDPOINTS, ESPN_ORIGIN, leagueLabel, leagueNameOf, overlayOf, parseScoreboard, scoreboardUrl } from '../../public/js/static/espn.js';

const DAY = 86_400_000;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
export const rangeUrl = (ep, from, to) => `${scoreboardUrl(ep)}?dates=${ymd(from) === ymd(to) ? ymd(from) : `${ymd(from)}-${ymd(to)}`}&limit=1000`;

const shortOf = (team) => {
  const abbr = String(team.abbr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (abbr) return abbr.slice(0, 4);
  const w = String(team.names[0] || '').split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 3) : w.slice(0, 3).map((x) => x[0]).join('')).toUpperCase();
};

/** Status JonBet dari status ESPN. null bila bentuknya tidak dikenal (laga dilewati). */
export function statusOf(ev) {
  const n = ev.name;
  if (/POSTPON|SUSPEND/.test(n)) return 'postponed';
  if (/CANCEL|ABANDON|FORFEIT/.test(n)) return 'cancelled';
  if (ev.state === 'in') return 'live';
  if (ev.state === 'post') return ev.completed || (ev.home.score !== null && ev.away.score !== null) ? 'finished' : null;
  if (ev.state === 'pre') return 'upcoming';
  return null;
}

/** Peristiwa hasil parseScoreboard -> objek pertandingan JonBet. null bila tidak layak dipakai. */
export function toMatch(ev, ep, leagueName) {
  if (!ID_RE.test(ev.id) || !SPORTS_BY_ID[ep.sport]) return null;
  const homeName = ev.home.names[0];
  const awayName = ev.away.names[0];
  if (!homeName || !awayName) return null;
  const status = statusOf(ev);
  if (!status) return null;

  const league = leagueName || leagueLabel(ep.path);
  const m = {
    id: `espn:${ev.id}`,
    sport: ep.sport,
    league,
    leagueId: ep.path,
    // Dipakai browser untuk skor langsung: jalur liga dan id yang pasti, tanpa menebak lewat nama.
    feed: ep.path,
    espnId: ev.id,
    // Logo tim sengaja tidak diambil: tampilan memakai inisial, dan tidak ada permintaan gambar ke pihak lain.
    home: { name: homeName, short: shortOf(ev.home), badge: null },
    away: { name: awayName, short: shortOf(ev.away), badge: null },
    kickoff: new Date(ev.date).toISOString(),
    status,
    minute: null,
    period: null,
    progress: null,
    score: null,
    stats: null,
    events: [],
    venue: ev.venue || null,
    source: 'espn',
  };

  if (status === 'live' || status === 'finished') {
    const ov = overlayOf({ sport: ep.sport, league }, ev, false);
    if (ov) {
      m.score = ov.score;
      m.minute = ov.minute;
      m.period = ov.period;
      m.progress = ov.progress;
    } else {
      // Cabang tanpa penghitung jam khusus, atau skor belum terbaca: tetap tampilkan statusnya.
      if (ev.home.score !== null && ev.away.score !== null) m.score = { home: ev.home.score, away: ev.away.score };
      m.period = status === 'finished' ? 'Selesai' : 'Live';
      m.progress = status === 'finished' ? 1 : null;
    }
    if (status === 'finished' && !m.score) return null; // hasil tanpa skor tidak bisa dipakai
  }
  return m;
}

export function createEspnProvider({ fetchImpl = globalThis.fetch, now = () => Date.now(), leagues = ENDPOINTS, timeoutMs = 15_000, concurrency = 4, log = () => {} } = {}) {
  const seen = new Map(); // id -> pertandingan terakhir yang dilihat
  let report = null;

  async function fetchBoard(ep, from, to) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rangeUrl(ep, from, to), { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Rentang tanggal pada papan skor ESPN terdokumentasi di pihak ketiga, tetapi ada sumber lain yang menyebut hanya satu hari
  // yang dilayani. Bila rentang >= 3 hari hanya mengembalikan laga di satu tanggal, anggap rentang diabaikan dan ambil per hari
  // (hanya untuk rentang pendek; rentang riwayat panjang tidak dipecah supaya jumlah permintaan tetap terbatas).
  let rangeSuspect = 0;
  async function boardRows(ep, from, to) {
    const rows = parseBoard(ep, await fetchBoard(ep, from, to));
    const days = Math.round((to - from) / DAY) + 1;
    if (days < 3 || !rows.length || new Set(rows.map((m) => m.kickoff.slice(0, 10))).size > 1) return rows;
    rangeSuspect++;
    if (days > 10) return rows;
    const byId = new Map(rows.map((m) => [m.id, m]));
    for (let t = from; t <= to; t += DAY) {
      try { for (const m of parseBoard(ep, await fetchBoard(ep, t, t))) byId.set(m.id, m); } catch { /* satu hari hilang, sisanya tetap dipakai */ }
    }
    return [...byId.values()];
  }

  function parseBoard(ep, json) {
    const name = leagueNameOf(json);
    const out = [];
    for (const ev of parseScoreboard(json)) {
      const m = toMatch(ev, ep, name);
      if (m) out.push(m);
    }
    return out;
  }

  return {
    name: 'espn',
    isDemo: false,
    premium: false,
    get report() { return report; },

    async listMatches({ from, to, sports = null }) {
      const wanted = leagues.filter((ep) => !sports || sports.includes(ep.sport));
      if (!wanted.length) return []; // cabang yang tidak dicakup ESPN (tenis, MMA, ...): bukan galat, sumber lain yang melayani
      const start = from - DAY; // selisih zona waktu: ESPN memotong hari menurut waktu setempatnya
      const end = to + DAY;
      const suspectBefore = rangeSuspect;
      const found = new Map();
      const failed = [];
      let ok = 0;
      let consecutive = 0;
      let aborted = false;
      const queue = [...wanted];

      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (queue.length && !aborted) {
          const ep = queue.shift();
          try {
            const rows = await boardRows(ep, start, end);
            ok++;
            consecutive = 0;
            for (const m of rows) found.set(m.id, m);
          } catch (err) {
            failed.push({ path: ep.path, error: String(err?.message || err).slice(0, 120) });
            consecutive++;
            // Semua permintaan awal gagal: sumbernya mati atau memblokir. Jangan menunggu puluhan liga lagi.
            if (ok === 0 && consecutive >= 8) aborted = true;
          }
        }
      }));

      const inWindow = [...found.values()].filter((m) => { const k = Date.parse(m.kickoff); return k >= from && k <= to; });
      report = { at: new Date(now()).toISOString(), tried: wanted.length - queue.length, ok, failed, events: inWindow.length, aborted, rangeSuspect: rangeSuspect - suspectBefore };
      if (failed.length) log(`ESPN: ${failed.length} liga gagal (${failed.slice(0, 6).map((f) => `${f.path} ${f.error}`).join('; ')}${failed.length > 6 ? '; ...' : ''})`);
      if (ok === 0) throw new Error(`ESPN tidak merespons (${failed.length} liga gagal): ${failed[0]?.error || 'tanpa liga'}`);
      for (const m of found.values()) seen.set(m.id, m);
      return inWindow;
    },

    async getMatch(id) {
      const raw = String(id).replace(/^espn:/, '');
      if (!ID_RE.test(raw)) return null;
      const known = seen.get(`espn:${raw}`);
      if (!known) return null; // jalur liga tidak diketahui tanpa pernah melihat laganya
      const ep = leagues.find((e) => e.path === known.feed);
      if (!ep) return known;
      try {
        const k = Date.parse(known.kickoff);
        const rows = await boardRows(ep, k - DAY, k + DAY);
        const fresh = rows.find((m) => m.id === known.id);
        if (fresh) { seen.set(fresh.id, fresh); return fresh; }
      } catch { /* pakai yang terakhir dilihat */ }
      return known;
    },
  };
}

export { ESPN_ORIGIN };

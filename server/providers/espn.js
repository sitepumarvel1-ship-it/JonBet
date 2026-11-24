// Penyedia data nyata dari scoreboard publik ESPN (jadwal, hasil, dan status live), dipanggil dari server/build.
//
// Catatan jujur:
//  - API ini tidak resmi dan tidak berdokumen; ESPN bisa mengubah atau membatasinya kapan saja.
//  - Satu permintaan rentang tanggal per liga (?dates=YYYYMMDD-YYYYMMDD) sudah memuat seluruh jadwal dan hasil di rentang itu.
//  - Hanya liga di tabel ENDPOINTS (public/js/static/espn.js) yang dicoba. Slug yang tidak ada hanya mencatat satu liga gagal;
//    sisanya tetap diproses. Ringkasan per liga tersedia di `provider.report` dan dicatat oleh skrip build.
//  - Tenis (ATP, WTA) dan rugby (liga bernomor, ditemukan lewat daftar liga ESPN bila rugbyDiscovery aktif) kini ikut dicakup.
//  - Cabang yang tidak dicakup (MMA, esports, bulu tangkis, voli, futsal) dilayani sumber lain.

import { SPORTS_BY_ID } from '../sports.js';
import { ENDPOINTS, ESPN_ORIGIN, leagueLabel, leagueNameOf, overlayOf, parseScoreboard, scoreboardUrl } from '../../public/js/static/espn.js';

const DAY = 86_400_000;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
// Tiga cara bertanya, dari yang paling hemat permintaan: rentang tanggal + limit, rentang tanpa limit, lalu satu hari per permintaan.
// ESPN tidak punya dokumentasi resmi; build nyata di GitHub menunjukkan HTTP 400 untuk bentuk pertama pada liga sepak bola,
// jadi penyedia ini beralih sendiri ke bentuk berikutnya (lihat boardRows).
export const MODES = ['range', 'range-nolimit', 'days'];
export const rangeUrl = (ep, from, to, mode = 'range') => `${scoreboardUrl(ep)}?dates=${ymd(from) === ymd(to) ? ymd(from) : `${ymd(from)}-${ymd(to)}`}${mode === 'range' ? '&limit=1000' : ''}`;
const USER_AGENT = 'JonBet/1.0 (aplikasi prediksi olahraga nirlaba; pembaca papan skor publik)';

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

  // Tenis: nama liga = tur + turnamen ("ATP Tour: Paris Masters"); respons ESPN untuk tur terlalu umum.
  const league = ep.sport === 'tennis' ? `${leagueLabel(ep.path)}${ev.tournament ? `: ${ev.tournament}` : ''}`.slice(0, 80) : (leagueName || leagueLabel(ep.path));
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
  // Tenis: game per set langsung dari papan skor (ESPN tidak memberi statistik tenis lain di sini).
  if (ep.sport === 'tennis' && Array.isArray(ev.sets) && ev.sets.length && status !== 'upcoming') {
    m.stats = ev.sets.map(([x, y], i) => ({ label: `Set ${i + 1} (game)`, home: x, away: y }));
  }
  return m;
}

// Daftar liga rugby ESPN memakai id numerik (bukan slug nama). Ditemukan dari endpoint inti ESPN; dicoba hanya bila diminta.
const RUGBY_LIST_URL = 'https://sports.core.api.espn.com/v2/sports/rugby/leagues?limit=100';
const RUGBY_MAX = 60;

export function createEspnProvider({ fetchImpl = globalThis.fetch, now = () => Date.now(), leagues = ENDPOINTS, timeoutMs = 15_000, concurrency = 4, log = () => {}, rugbyDiscovery = false } = {}) {
  const seen = new Map(); // id -> pertandingan terakhir yang dilihat
  let report = null;

  async function fetchBoard(ep, from, to, mode = 'range') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rangeUrl(ep, from, to, mode), { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Mode pertanyaan. Dimulai dari yang paling hemat. Satu liga yang ditolak (HTTP 400) mencoba mode berikutnya sendiri; mode global baru
  // naik setelah 3 liga berbeda perlu naik DAN mode lama belum pernah berhasil, supaya satu slug salah tidak memaksa semua liga
  // memakai mode boros. okIn/promoted: hitungan keberhasilan per mode.
  let mode = 0;
  const okIn = MODES.map(() => 0);
  const promoted = MODES.map(() => 0);
  const badRequest = (err) => /\bHTTP 400\b/.test(String(err?.message));

  // Mode "days": satu permintaan per hari. Kegagalan hari pertama langsung dilempar (hari lain akan gagal sama), selanjutnya dilewati.
  async function daysRows(ep, from, to) {
    const byId = new Map();
    let first = true;
    for (let t = from; ymd(t) <= ymd(to); t += DAY) {
      try {
        for (const m of parseBoard(ep, await fetchBoard(ep, t, t, 'days'))) byId.set(m.id, m);
      } catch (err) {
        if (first) throw err;
      }
      first = false;
    }
    return [...byId.values()];
  }

  // Rentang >= 3 hari yang hanya mengembalikan laga di satu tanggal berarti rentang diabaikan: ambil per hari (rentang pendek saja;
  // rentang riwayat panjang tidak dipecah supaya jumlah permintaan tetap terbatas).
  let rangeSuspect = 0;
  async function boardRows(ep, from, to) {
    for (let m = mode; ; m++) {
      let rows;
      try {
        rows = MODES[m] === 'days' ? await daysRows(ep, from, to) : parseBoard(ep, await fetchBoard(ep, from, to, MODES[m]));
      } catch (err) {
        if (!badRequest(err) || m >= MODES.length - 1 || okIn[m] > 0) throw err;
        continue; // ditolak dan mode ini belum pernah berhasil untuk liga lain: coba mode berikutnya untuk liga ini
      }
      okIn[m]++;
      if (m > mode && ++promoted[m] >= 3 && okIn[mode] === 0) { mode = m; log(`ESPN: bentuk permintaan sebelumnya ditolak (HTTP 400), beralih ke mode "${MODES[m]}".`); }
      if (MODES[m] === 'days') return rows;
      const days = Math.round((to - from) / DAY) + 1;
      if (days < 3 || !rows.length || new Set(rows.map((x) => x.kickoff.slice(0, 10))).size > 1) return rows;
      rangeSuspect++;
      if (days > 10) return rows;
      return daysRows(ep, from, to).then((extra) => { const byId = new Map(rows.map((x) => [x.id, x])); for (const x of extra) byId.set(x.id, x); return [...byId.values()]; }, () => rows);
    }
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

  // Penemuan liga rugby: satu permintaan, hasil dipakai ulang selama proses hidup. Gagal = rugby dilayani sumber lain; tercatat di report.rugby.
  let rugbyEps = null;
  let rugbyInfo = null;
  async function discoverRugby() {
    if (rugbyEps) return rugbyEps;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let json;
      try {
        const res = await fetchImpl(RUGBY_LIST_URL, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      } finally { clearTimeout(timer); }
      const ids = [];
      for (const it of Array.isArray(json?.items) ? json.items : []) {
        const m = /\/leagues\/(\d{1,8})(?:\D|$)/.exec(String(it?.$ref ?? it?.id ?? ''));
        const id = m ? m[1] : /^\d{1,8}$/.test(String(it?.id ?? '')) ? String(it.id) : null;
        if (id && !ids.includes(id)) ids.push(id);
      }
      rugbyEps = ids.slice(0, RUGBY_MAX).map((id) => ({ sport: 'rugby', path: `rugby/${id}` }));
      rugbyInfo = { ok: true, leagues: rugbyEps.length, found: ids.length };
    } catch (err) {
      rugbyEps = [];
      rugbyInfo = { ok: false, error: String(err?.message || err).slice(0, 100) };
      log(`ESPN: daftar liga rugby gagal diambil (${rugbyInfo.error}); rugby memakai sumber lain.`);
    }
    return rugbyEps;
  }

  return {
    name: 'espn',
    isDemo: false,
    premium: false,
    owns: (id) => String(id).startsWith('espn:'),
    get report() { return report; },

    async listMatches({ from, to, sports = null }) {
      const base = rugbyDiscovery && (!sports || sports.includes('rugby')) ? [...leagues, ...(await discoverRugby())] : leagues;
      const wanted = base.filter((ep) => !sports || sports.includes(ep.sport));
      if (!wanted.length) {
        if (rugbyInfo) report = { at: new Date(now()).toISOString(), tried: 0, ok: 0, failed: [], events: 0, aborted: false, rangeSuspect: 0, mode: MODES[mode], rugby: rugbyInfo };
        return [];
      } // cabang yang tidak dicakup ESPN (tenis, MMA, ...): bukan galat, sumber lain yang melayani
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
      report = { at: new Date(now()).toISOString(), tried: wanted.length - queue.length, ok, failed, events: inWindow.length, aborted, rangeSuspect: rangeSuspect - suspectBefore, mode: MODES[mode], ...(rugbyInfo ? { rugby: rugbyInfo } : {}) };
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
      const ep = [...leagues, ...(rugbyEps || [])].find((e) => e.path === known.feed);
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

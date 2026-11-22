// Sumber data tambahan dari API publik tanpa kunci: OpenLigaDB (Bundesliga 1-3 dan DFB-Pokal), MLB Stats API (baseball), NHL (hoki es).
// Dipakai sebagai lapisan antara ESPN (utama) dan TheSportsDB: laga yang sama dengan ESPN dibuang (versi ESPN dipakai), laga yang tidak
// ada di ESPN ditambahkan, dan bila ESPN mati sumber-sumber ini menjadi cadangan untuk liga yang mereka cakup.
//
// Catatan jujur: bentuk respons ditulis dari dokumentasi publik masing-masing layanan dan diuji dengan respons buatan sendiri; layanan
// aslinya belum dihubungi dari lingkungan pengembangan. Tiap sumber berdiri sendiri: satu gagal tidak menggagalkan yang lain, dan
// hasilnya dilaporkan per sumber (provider.report) supaya kegagalan terlihat di data/meta.json.
import { SPORTS_BY_ID } from '../sports.js';

const DAY = 86_400_000;
const MIN = 60_000;
const ID_RE = /^pub:[A-Za-z0-9_-]{1,44}$/;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const str = (x, n = 60) => String(x ?? '').trim().slice(0, n);
const int = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
};
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const USER_AGENT = 'JonBet/1.0 (aplikasi prediksi olahraga nirlaba; pembaca data publik)';

const shortOf = (name, abbr) => {
  const a = String(abbr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (a) return a.slice(0, 4);
  const w = String(name || '').split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 3) : w.slice(0, 3).map((x) => x[0]).join('')).toUpperCase();
};

function base({ id, sport, league, leagueId, home, away, kickoff, status, venue = null }) {
  return {
    id, sport, league, leagueId, feed: null,
    home: { name: home.name, short: shortOf(home.name, home.abbr), badge: null },
    away: { name: away.name, short: shortOf(away.name, away.abbr), badge: null },
    kickoff: new Date(kickoff).toISOString(), status,
    minute: null, period: null, progress: null, score: null, stats: null, events: [], venue: venue ? str(venue, 80) : null,
    source: 'public',
  };
}

function finish(m, score, extra = {}) {
  if (m.status === 'finished') { m.score = score; m.period = 'Selesai'; m.progress = 1; }
  else if (m.status === 'live') { m.score = score; m.period = extra.period || 'Live'; m.minute = extra.minute ?? null; m.progress = extra.progress ?? null; }
  return m;
}

/* ------------------------------------------------------------------ OpenLigaDB */

const OPENLIGA = 'https://api.openligadb.de';
const OL_LEAGUES = [['bl1', 'German Bundesliga'], ['bl2', 'German 2. Bundesliga'], ['bl3', 'German 3. Liga'], ['dfb', 'DFB-Pokal']];
// Musim OpenLigaDB dinamai menurut tahun mulainya: Juli-Desember = tahun ini, Januari-Juni = tahun lalu.
const seasonOf = (ms) => { const d = new Date(ms); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };

// Gol OpenLigaDB -> peristiwa: sisi ditentukan dari skor yang bertambah (scoreTeam1 naik = tuan rumah).
function goalEventsOf(goals) {
  const list = (Array.isArray(goals) ? goals : []).filter((g) => int(g?.scoreTeam1) !== null && int(g?.scoreTeam2) !== null)
    .sort((x, y) => (x.scoreTeam1 + x.scoreTeam2) - (y.scoreTeam1 + y.scoreTeam2));
  const out = [];
  let h = 0;
  let a = 0;
  for (const g of list.slice(0, 40)) {
    const side = g.scoreTeam1 > h ? 'home' : g.scoreTeam2 > a ? 'away' : null;
    h = g.scoreTeam1; a = g.scoreTeam2;
    if (!side) continue;
    const minute = int(g.matchMinute);
    out.push({ type: 'goal', side, minute, clock: minute === null ? '' : `${minute}'`, player: str(g.goalGetterName, 40) || null });
  }
  return out;
}

export function parseOpenLiga(rows, leagueName, leagueId, nowMs) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const kick = Date.parse(r?.matchDateTimeUTC);
    const home = str(r?.team1?.teamName);
    const away = str(r?.team2?.teamName);
    if (!Number.isFinite(kick) || !home || !away || r?.matchID == null) continue;
    const id = `pub:ol-${r.matchID}`;
    if (!ID_RE.test(id)) continue;
    const results = Array.isArray(r.matchResults) ? r.matchResults : [];
    const final = results.find((x) => Number(x?.resultTypeID) === 2) || (r.matchIsFinished ? results[results.length - 1] : null);
    let status;
    let score = null;
    let extra = {};
    if (r.matchIsFinished) {
      const h = int(final?.pointsTeam1);
      const a = int(final?.pointsTeam2);
      if (h === null || a === null) continue; // hasil tanpa skor tidak bisa dipakai
      status = 'finished';
      score = { home: h, away: a };
    } else if (kick > nowMs) {
      status = 'upcoming';
    } else if (nowMs - kick < 150 * MIN) {
      // OpenLigaDB tidak punya penanda live; dianggap berjalan antara jam mulai dan 2,5 jam sesudahnya bila belum ditandai selesai.
      status = 'live';
      const goals = (Array.isArray(r.goals) ? r.goals : []).filter((g) => int(g?.scoreTeam1) !== null && int(g?.scoreTeam2) !== null);
      goals.sort((x, y) => (x.scoreTeam1 + x.scoreTeam2) - (y.scoreTeam1 + y.scoreTeam2));
      const last = goals[goals.length - 1];
      score = last ? { home: last.scoreTeam1, away: last.scoreTeam2 } : { home: 0, away: 0 };
      extra = { period: 'Live', progress: clamp((nowMs - kick) / (105 * MIN), 0, 0.95) };
    } else {
      continue; // lewat jam mulai tetapi belum ditandai selesai: datanya tertinggal, lebih baik tidak ditampilkan
    }
    const m = finish(base({ id, sport: 'football', league: str(leagueName), leagueId, home: { name: home, abbr: r.team1?.shortName }, away: { name: away, abbr: r.team2?.shortName }, kickoff: kick, status, venue: r.location?.locationStadium }), score, extra);
    if (status !== 'upcoming') m.events = goalEventsOf(r.goals);
    out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ MLB Stats API */

const MLB_URL = 'https://statsapi.mlb.com/api/v1/schedule';
const HALF = { Top: 'Atas', Bottom: 'Bawah', Middle: 'Tengah', End: 'Akhir' };

export function parseMlb(json) {
  const out = [];
  for (const d of Array.isArray(json?.dates) ? json.dates : []) {
    for (const g of Array.isArray(d?.games) ? d.games : []) {
      const kick = Date.parse(g?.gameDate);
      const home = str(g?.teams?.home?.team?.name);
      const away = str(g?.teams?.away?.team?.name);
      if (!Number.isFinite(kick) || !home || !away || g?.gamePk == null) continue;
      const abstract = str(g?.status?.abstractGameState, 20);
      const detail = str(g?.status?.detailedState, 40);
      let status;
      if (/Postponed|Suspended/i.test(detail)) status = 'postponed';
      else if (/Cancel/i.test(detail)) status = 'cancelled';
      else if (abstract === 'Final') status = 'finished';
      else if (abstract === 'Live') status = 'live';
      else if (abstract === 'Preview') status = 'upcoming';
      else continue;
      const hs = int(g?.teams?.home?.score);
      const as = int(g?.teams?.away?.score);
      let extra = {};
      if (status === 'live') {
        const ls = g.linescore || {};
        const inning = int(ls.currentInning);
        extra = { period: inning ? `${HALF[ls.inningState] || 'Inning'} ${inning}`.trim() : 'Live', progress: inning ? clamp((inning - 0.5) / 9, 0.02, 0.98) : null };
      }
      if ((status === 'live' || status === 'finished') && (hs === null || as === null)) {
        if (status === 'finished') continue;
        extra = { period: 'Live', progress: null }; // skor belum terbaca: tampilkan status saja
      }
      const m = base({ id: `pub:mlb-${g.gamePk}`, sport: 'baseball', league: 'MLB', leagueId: 'mlb', home: { name: home }, away: { name: away }, kickoff: kick, status, venue: g.venue?.name });
      out.push(finish(m, hs !== null && as !== null ? { home: hs, away: as } : null, extra));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ NHL */

const NHL_URL = 'https://api-web.nhle.com/v1/score';
const nhlName = (t) => {
  const place = str(t?.placeName?.default);
  const name = str(t?.name?.default);
  return place && name && !name.toLowerCase().startsWith(place.toLowerCase()) ? `${place} ${name}` : name || place;
};

export function parseNhl(json) {
  const out = [];
  for (const g of Array.isArray(json?.games) ? json.games : []) {
    const kick = Date.parse(g?.startTimeUTC);
    const home = nhlName(g?.homeTeam);
    const away = nhlName(g?.awayTeam);
    if (!Number.isFinite(kick) || !home || !away || g?.id == null) continue;
    const st = str(g?.gameState, 8).toUpperCase();
    const status = st === 'FUT' || st === 'PRE' ? 'upcoming' : st === 'LIVE' || st === 'CRIT' ? 'live' : st === 'FINAL' || st === 'OFF' ? 'finished' : st === 'PPD' ? 'postponed' : null;
    if (!status) continue;
    const hs = int(g?.homeTeam?.score);
    const as = int(g?.awayTeam?.score);
    let extra = {};
    if (status === 'live') {
      const n = int(g?.periodDescriptor?.number ?? g?.period);
      const type = str(g?.periodDescriptor?.periodType, 4).toUpperCase();
      const rem = /^(\d{1,2}):(\d{2})$/.exec(str(g?.clock?.timeRemaining, 8));
      const left = rem ? Number(rem[1]) * 60 + Number(rem[2]) : null;
      if (type === 'SO') extra = { period: 'Adu penalti', progress: 0.99 };
      else if (type === 'OT') extra = { period: 'Perpanjangan', progress: 0.97 };
      else if (n && n <= 3) {
        const into = left === null ? 0.5 : clamp(1 - left / 1200, 0, 1); // 20 menit per babak
        extra = { period: g?.clock?.inIntermission ? `Jeda babak ${n}` : `Babak ${n}`, minute: left === null ? null : Math.floor((n - 1) * 20 + into * 20), progress: clamp((n - 1 + into) / 3, 0.02, 0.98) };
      } else extra = { period: 'Live', progress: null };
    }
    if ((status === 'live' || status === 'finished') && (hs === null || as === null)) {
      if (status === 'finished') continue;
      extra = { period: 'Live', progress: null };
    }
    const m = base({ id: `pub:nhl-${g.id}`, sport: 'icehockey', league: 'NHL', leagueId: 'nhl', home: { name: home, abbr: g.homeTeam?.abbrev }, away: { name: away, abbr: g.awayTeam?.abbrev }, kickoff: kick, status });
    out.push(finish(m, hs !== null && as !== null ? { home: hs, away: as } : null, extra));
  }
  return out;
}

/* ------------------------------------------------------------------ penyedia */

export function createPublicProvider({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000, only = null, log = () => {} } = {}) {
  const seen = new Map();
  let report = null;

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  const SOURCES = [
    {
      key: 'openligadb', sport: 'football',
      async run(from, to) {
        const seasons = [...new Set([seasonOf(from), seasonOf(to)])];
        const rows = [];
        let ok = 0;
        let lastErr = null;
        for (const [code, name] of OL_LEAGUES) {
          for (const s of seasons) {
            try { rows.push(...parseOpenLiga(await getJson(`${OPENLIGA}/getmatchdata/${code}/${s}`), name, `openliga/${code}`, now())); ok++; } catch (e) { lastErr = e; }
          }
        }
        if (!ok) throw lastErr || new Error('tanpa liga');
        return rows;
      },
    },
    {
      key: 'mlb', sport: 'baseball',
      run: async (from, to) => parseMlb(await getJson(`${MLB_URL}?sportId=1&startDate=${ymd(from)}&endDate=${ymd(to)}&hydrate=linescore`)),
    },
    {
      key: 'nhl', sport: 'icehockey',
      async run(from, to) {
        const days = [];
        for (let t = from; t <= to + 1 && days.length < 12; t += DAY) days.push(ymd(t));
        const rows = [];
        let ok = 0;
        let lastErr = null;
        for (const d of days) {
          try { rows.push(...parseNhl(await getJson(`${NHL_URL}/${d}`))); ok++; } catch (e) { lastErr = e; }
        }
        if (!ok) throw lastErr || new Error('tanpa hari');
        return rows;
      },
    },
  ].filter((s) => !only || only.includes(s.key));

  return {
    name: 'public',
    isDemo: false,
    premium: false,
    get report() { return report; },
    owns: (id) => String(id).startsWith('pub:'),

    async listMatches({ from, to, sports = null }) {
      const wanted = SOURCES.filter((s) => (!sports || sports.includes(s.sport)) && SPORTS_BY_ID[s.sport]);
      if (!wanted.length) return [];
      const start = from - DAY;
      const end = to + DAY;
      const res = await Promise.allSettled(wanted.map((s) => s.run(start, end)));
      const found = new Map();
      const per = {};
      res.forEach((r, i) => {
        const key = wanted[i].key;
        if (r.status === 'rejected') { per[key] = { ok: false, error: String(r.reason?.message || r.reason).slice(0, 120) }; log(`${key} gagal: ${per[key].error}`); return; }
        const rows = r.value.filter((m) => { const k = Date.parse(m.kickoff); return k >= from && k <= to; });
        per[key] = { ok: true, events: rows.length };
        for (const m of rows) found.set(m.id, m);
      });
      report = { at: new Date(now()).toISOString(), sources: per };
      if (Object.values(per).every((p) => !p.ok)) throw new Error(`Sumber publik tidak merespons: ${Object.entries(per).map(([k, v]) => `${k} ${v.error}`).join('; ')}`);
      for (const m of found.values()) seen.set(m.id, m);
      return [...found.values()];
    },

    async getMatch(id) {
      return seen.get(String(id)) || null;
    },
  };
}

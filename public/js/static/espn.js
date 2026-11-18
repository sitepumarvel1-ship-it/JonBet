// Sumber skor langsung untuk mode statis: scoreboard publik ESPN yang dipanggil langsung dari browser.
//
// Catatan jujur:
//  - API ini tidak resmi dan tidak berdokumen; ESPN bisa mengubah atau membatasinya kapan saja.
//  - Hanya liga yang ada di tabel ENDPOINTS yang dicoba. Laga lain tetap memakai data jadwal dari build.
//  - Modul ini murni (tanpa DOM, tanpa jaringan) supaya bisa diuji di Node; pemanggilan jaringan ada di live.js.

export const ESPN_ORIGIN = 'https://site.api.espn.com';
const BASE = `${ESPN_ORIGIN}/apis/site/v2/sports/`;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------------------------------------------ endpoint per liga */

const T = (sport, path, re) => ({ sport, path, re });

// Pola dicocokkan dengan nama liga TheSportsDB yang sudah dinormalkan (huruf kecil, tanpa tanda baca).
// Urutan penting: yang lebih spesifik lebih dulu. Slug yang salah hanya berujung 404 lalu ditunda (lihat live.js).
export const ENDPOINTS = [
  T('football', 'soccer/eng.1', /^(english )?premier league$/),
  T('football', 'soccer/eng.2', /^english (league )?championship$|^(efl )?championship$/),
  T('football', 'soccer/eng.3', /^english league one$/),
  T('football', 'soccer/eng.4', /^english league two$/),
  T('football', 'soccer/eng.fa', /^(english )?fa cup$/),
  T('football', 'soccer/eng.league_cup', /^(english )?(efl|league|carabao) cup$/),
  T('football', 'soccer/esp.2', /^spanish (segunda division|la liga 2)$|^la liga 2$/),
  T('football', 'soccer/esp.1', /^spanish la liga$|^la ?liga$/),
  T('football', 'soccer/esp.copa_del_rey', /copa del rey/),
  T('football', 'soccer/ger.2', /^german (2 bundesliga|bundesliga 2)$|^2 bundesliga$/),
  T('football', 'soccer/ger.1', /^german bundesliga$|^bundesliga$/),
  T('football', 'soccer/ger.dfb_pokal', /dfb pokal/),
  T('football', 'soccer/ita.2', /^italian serie b$|^serie b$/),
  T('football', 'soccer/ita.1', /^italian serie a$|^serie a$/),
  T('football', 'soccer/ita.coppa_italia', /coppa italia/),
  T('football', 'soccer/fra.2', /^french ligue 2$|^ligue 2$/),
  T('football', 'soccer/fra.1', /^french ligue 1$|^ligue 1$/),
  T('football', 'soccer/ned.1', /^dutch eredivisie$|^eredivisie$/),
  T('football', 'soccer/por.1', /^portuguese primeira liga$|^primeira liga$|^liga portugal$/),
  T('football', 'soccer/sco.1', /^scottish premiership$/),
  T('football', 'soccer/tur.1', /^turkish super lig$|^super lig$/),
  T('football', 'soccer/bel.1', /^belgian (first division a|pro league)$|^jupiler pro league$/),
  T('football', 'soccer/bra.1', /^brazilian serie a$|brasileirao/),
  T('football', 'soccer/arg.1', /^argentin(e|ian) (primera division|liga profesional|primera)$|^liga profesional/),
  T('football', 'soccer/mex.1', /^mexican (primera|liga mx)|^liga mx$/),
  T('football', 'soccer/usa.1', /^american major league soccer$|^major league soccer$|^mls$/),
  T('football', 'soccer/uefa.champions', /^uefa champions league$|^champions league$/),
  T('football', 'soccer/uefa.europa.conf', /conference league/),
  T('football', 'soccer/uefa.europa', /^uefa europa league$|^europa league$/),
  T('football', 'soccer/idn.1', /^indonesian (liga 1|super league)|^liga 1 indonesia$|^bri liga 1$|^super league indonesia$/),
  T('football', 'soccer/aus.1', /^australian a league$|^a league( men)?$/),
  T('football', 'soccer/jpn.1', /^japanese j1 league$|^j1 league$|^j league$/),
  T('football', 'soccer/ksa.1', /^saudi (arabian )?pro league$/),
  T('basketball', 'basketball/nba', /^nba$|^national basketball association$/),
  T('basketball', 'basketball/wnba', /^wnba$/),
  T('basketball', 'basketball/womens-college-basketball', /^(ncaa|college|wncaa).*\bwomen|^wncaa/),
  T('basketball', 'basketball/mens-college-basketball', /^(ncaa|college)/),
  T('americanfootball', 'football/nfl', /^nfl$|^national football league$/),
  T('americanfootball', 'football/cfl', /^cfl$|^canadian football league$/),
  T('americanfootball', 'football/college-football', /^(ncaa|college|ncaaf)/),
  T('baseball', 'baseball/mlb', /^mlb$|^major league baseball$/),
  T('icehockey', 'hockey/nhl', /^nhl$|^national hockey league$/),
];

// Cadangan untuk liga sepak bola yang tidak ada di tabel. Belum pasti tersedia; bila gagal akan ditunda lama.
const GENERIC = { sport: 'football', path: 'soccer/all', generic: true };

/** Endpoint ESPN yang mungkin memuat laga ini (0 atau 1 elemen). */
export function endpointsFor(match) {
  const league = norm(match?.league);
  const hit = ENDPOINTS.find((e) => e.sport === match?.sport && e.re.test(league));
  if (hit) return [hit];
  return match?.sport === GENERIC.sport ? [GENERIC] : [];
}

export const scoreboardUrl = (ep) => `${BASE}${ep.path}/scoreboard`;

/* ------------------------------------------------------------------ membaca respons */

const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
const unique = (a) => [...new Set(a.filter(Boolean).map(String))];

function scoreOf(c) {
  const v = c?.score;
  const raw = v && typeof v === 'object' ? (v.value ?? v.displayValue) : v;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
}

const teamOf = (c) => ({
  // Singkatan (MCI) dan kota ("Los Angeles") sengaja tidak dipakai: terlalu mudah cocok dengan tim yang salah.
  names: unique([c?.team?.displayName, c?.team?.shortDisplayName, c?.team?.name]),
  score: scoreOf(c),
});

/** Ubah JSON scoreboard ESPN menjadi daftar peristiwa ringkas. Entri yang bentuknya tidak dikenal dilewati. */
export function parseScoreboard(json) {
  const out = [];
  const events = Array.isArray(json?.events) ? json.events : [];
  for (const e of events) {
    const comp = e?.competitions?.[0];
    const cs = comp?.competitors;
    if (!Array.isArray(cs) || cs.length !== 2) continue;
    const home = cs.find((c) => c?.homeAway === 'home');
    const away = cs.find((c) => c?.homeAway === 'away');
    if (!home || !away) continue;
    const date = Date.parse(e.date || comp.date || comp.startDate);
    if (!Number.isFinite(date)) continue;
    const status = e.status || comp.status || {};
    const type = status.type || {};
    const period = num(status.period);
    const clockSec = num(status.clock);
    out.push({
      id: String(e.id ?? ''),
      date,
      home: teamOf(home),
      away: teamOf(away),
      state: String(type.state || ''),
      name: String(type.name || ''),
      completed: type.completed === true,
      period: Number.isInteger(period) && period >= 0 ? period : null,
      clock: String(status.displayClock ?? ''),
      clockSec: Number.isFinite(clockSec) && clockSec >= 0 ? clockSec : null,
      detail: String(type.shortDetail || type.detail || ''),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ pencocokan nama tim */

const GENERIC_TOKENS = new Set([
  'fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'ssc', 'cd', 'ud', 'rc', 'rcd', 'fk', 'sk', 'bk', 'if', 'sv', 'vfb', 'vfl', 'fsv', 'tsg',
  'club', 'de', 'del', 'di', 'da', 'the', 'of', 'and',
]);
const ALIAS = { man: 'manchester', utd: 'united', spurs: 'tottenham', wolves: 'wolverhampton', ny: 'new york', st: 'saint', psg: 'paris saint germain' };

// Penanda tim lain dengan nama dasar yang sama (putri, cadangan, usia): kedua nama harus memiliki penanda yang sama.
const QUALIFIER = { women: 'w', womens: 'w', ladies: 'w', w: 'w', ii: 'r', b: 'r', reserves: 'r', res: 'r', youth: 'y', academy: 'y', u17: 'u17', u18: 'u18', u19: 'u19', u20: 'u20', u21: 'u21', u23: 'u23' };
// Hanya kata setelah kata pertama yang dihitung ("B. Monchengladbach" bukan tim B).
const qualifiers = (name) => [...new Set(norm(name).split(' ').slice(1).map((t) => QUALIFIER[t]).filter(Boolean))].sort().join(',');

function tokens(name) {
  const out = [];
  norm(name).split(' ').forEach((t, i) => {
    if (i > 0 && QUALIFIER[t]) return;
    for (const x of (ALIAS[t] || t).split(' ')) if (x.length > 1 && !GENERIC_TOKENS.has(x)) out.push(x);
  });
  return out;
}

const tokEq = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** 0 bila tidak cocok; selain itu 0,6 sampai 1. Semua kata pada nama yang lebih pendek harus ada di nama yang lebih panjang. */
export function nameScore(a, b) {
  if (qualifiers(a) !== qualifiers(b)) return 0;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set();
  let matched = 0;
  for (const x of s) {
    const j = l.findIndex((y, i) => !used.has(i) && tokEq(x, y));
    if (j >= 0) { used.add(j); matched++; }
  }
  if (matched < s.length) return 0;
  return 0.6 + 0.4 * (matched / (ta.length + tb.length - matched));
}

const teamScore = (name, variants) => variants.reduce((best, v) => Math.max(best, nameScore(name, v)), 0);

/**
 * Cari peristiwa ESPN untuk sebuah laga. Kedua nama tim harus cocok (urutan kandang/tandang boleh terbalik) dan
 * jam mulai berdekatan. Bila dua kandidat sama baiknya, tidak ada yang dipilih: lebih baik tanpa overlay daripada salah laga.
 * @returns {{ev: object, swapped: boolean}|null}
 */
export function pickEvent(match, events, { maxGapMs = 8 * 3600_000 } = {}) {
  const kickoff = Date.parse(match?.kickoff);
  if (!Number.isFinite(kickoff) || !match?.home?.name || !match?.away?.name) return null;
  const cands = [];
  for (const ev of events) {
    const gap = Math.abs(ev.date - kickoff);
    if (gap > maxGapMs) continue;
    const direct = teamScore(match.home.name, ev.home.names) && teamScore(match.away.name, ev.away.names)
      ? teamScore(match.home.name, ev.home.names) + teamScore(match.away.name, ev.away.names) : 0;
    const swap = teamScore(match.home.name, ev.away.names) && teamScore(match.away.name, ev.home.names)
      ? teamScore(match.home.name, ev.away.names) + teamScore(match.away.name, ev.home.names) : 0;
    if (!direct && !swap) continue;
    cands.push({ ev, gap, total: Math.max(direct, swap), swapped: swap > direct });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.total - a.total || a.gap - b.gap);
  const [first, second] = cands;
  if (second && first.total - second.total < 0.05 && Math.abs(first.gap - second.gap) < 2 * 3600_000) return null;
  return { ev: first.ev, swapped: first.swapped };
}

/* ------------------------------------------------------------------ jam dan babak per cabang */

const clockText = (ev) => (ev.clock && /\d/.test(ev.clock) ? ev.clock.trim() : '');

function soccerClock(ev) {
  if (ev.name === 'STATUS_HALFTIME') return { minute: 45, period: 'Turun minum', progress: 0.5 };
  if (/SHOOTOUT|PENALT/.test(ev.name)) return { minute: 120, period: 'Adu penalti', progress: 0.99 };
  const m = /^(\d+)\s*['′’]?\s*(?:\+\s*(\d+))?/.exec(ev.clock.trim());
  const minute = m ? Number(m[1]) + (m[2] ? Number(m[2]) : 0) : null;
  const extra = /EXTRA|OVERTIME/.test(ev.name) || (minute !== null && minute > 90);
  const period = extra ? 'Perpanjangan' : ev.period === 1 ? 'Babak 1' : ev.period === 2 ? 'Babak 2' : 'Live';
  return { minute, period, progress: minute === null ? null : clamp(minute / 90, 0, 0.99) };
}

/** Struktur babak reguler: [jumlah babak, detik per babak, awalan label]. */
function structure(sportId, leagueNorm) {
  if (sportId === 'basketball') {
    const college = /ncaa|college/.test(leagueNorm);
    const women = /\bwomen|wncaa|wnba/.test(leagueNorm);
    if (college && !women) return [2, 1200, 'H'];
    return [4, women ? 600 : 720, 'Q'];
  }
  if (sportId === 'americanfootball') return [4, 900, 'Q'];
  if (sportId === 'icehockey') return [3, 1200, 'P'];
  return null;
}

function periodClock(sportId, ev, leagueNorm) {
  const [n, per, tag] = structure(sportId, leagueNorm);
  const p = Math.max(1, ev.period ?? 1);
  const left = ev.clockSec ?? (/^\d+:\d{2}$/.test(ev.clock.trim()) ? Number(ev.clock.split(':')[0]) * 60 + Number(ev.clock.split(':')[1]) : null);
  const regular = p <= n;
  let period;
  let progress;
  if (ev.name === 'STATUS_HALFTIME') { period = 'Turun minum'; progress = 0.5; }
  else if (ev.name === 'STATUS_END_PERIOD') { period = `Akhir ${regular ? tag + p : 'OT'}`; progress = regular ? clamp(p / n, 0, 0.99) : 0.99; }
  else {
    const label = regular ? `${tag}${p}` : (p - n > 1 ? `OT${p - n}` : 'OT');
    period = [label, clockText(ev)].filter(Boolean).join(' ');
    progress = regular ? clamp(((p - 1) + (1 - (left ?? per / 2) / per)) / n, 0, 0.99) : 0.99;
  }
  const out = { minute: null, period, progress };
  if (sportId === 'icehockey') out.minute = Math.min(60, Math.round(progress * 60));
  return out;
}

function baseballClock(ev) {
  const p = Math.max(1, ev.period ?? 1);
  const half = /^(top|bot|bottom|mid|middle|end)\b/i.exec(ev.detail.trim())?.[1]?.toLowerCase();
  const bottom = half === 'bot' || half === 'bottom';
  const between = half === 'mid' || half === 'middle';
  const ended = half === 'end';
  const where = bottom ? 'bawah' : between ? 'jeda' : ended ? 'selesai' : 'atas';
  const frac = bottom ? 0.75 : between ? 0.5 : ended ? 1 : 0.25;
  return { minute: null, period: `Inning ${p} (${where})`, progress: p <= 9 ? clamp((p - 1 + frac) / 9, 0.02, 0.99) : 0.99 };
}

/**
 * Bentuk overlay (yang menimpa status/skor snapshot) dari peristiwa ESPN. null bila belum layak ditimpa
 * (laga belum mulai, ditunda/dibatalkan, skor tidak terbaca, atau cabang yang tidak didukung).
 */
export function overlayOf(match, ev, swapped) {
  if (/POSTPON|CANCEL|FORFEIT|ABANDON/.test(ev.name)) return null;
  let status = null;
  if (ev.state === 'in') status = 'live';
  else if (ev.state === 'post' && ev.completed) status = 'finished';
  if (!status) return null;
  const hs = swapped ? ev.away.score : ev.home.score;
  const as = swapped ? ev.home.score : ev.away.score;
  if (hs === null || as === null) return null;

  const league = norm(match.league);
  let clock;
  if (status === 'finished') clock = { minute: null, period: 'Selesai', progress: 1 };
  else if (match.sport === 'football') clock = soccerClock(ev);
  else if (structure(match.sport, league)) clock = periodClock(match.sport, ev, league);
  else if (match.sport === 'baseball') clock = baseballClock(ev);
  else return null;

  return { status, score: { home: hs, away: as }, minute: clock.minute, period: clock.period, progress: clock.progress, espnId: ev.id };
}

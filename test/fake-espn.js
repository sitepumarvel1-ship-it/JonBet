// Respons scoreboard ESPN palsu (bentuk mengikuti JSON publik ESPN) untuk tes sumber skor langsung.
export function espnEvent({
  id = '1', date, home, away, hs = 0, as = 0, state = 'in', name = 'STATUS_IN_PROGRESS', completed = false,
  period = 1, clock = '', clockSec = null, detail = '', homeNames, awayNames, venue,
}) {
  const team = (display, extra) => ({ displayName: display, shortDisplayName: extra?.short ?? display, name: extra?.name ?? display, abbreviation: extra?.abbr ?? display.slice(0, 3).toUpperCase() });
  return {
    id,
    date: new Date(date).toISOString(),
    status: { clock: clockSec, displayClock: clock, period, type: { state, name, completed, shortDetail: detail } },
    competitions: [{
      ...(venue ? { venue: { fullName: venue } } : {}),
      competitors: [
        { homeAway: 'home', score: String(hs), team: team(home, homeNames) },
        { homeAway: 'away', score: String(as), team: team(away, awayNames) },
      ],
    }],
  };
}

/** fetch palsu: peta URL -> isi (objek) | Error | {status}. Mencatat setiap panggilan. */
export function fakeEspn(routes = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes[String(url)];
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'function') return impl.respond(hit(calls.length));
    return impl.respond(hit);
  };
  impl.respond = (hit) => {
    if (hit === undefined) return new Response('{}', { status: 404 });
    if (hit && hit.status) return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status });
    return new Response(JSON.stringify(hit), { status: 200 });
  };
  impl.calls = calls;
  impl.routes = routes;
  return impl;
}
export const board = (...events) => ({ events });

/* ------------------------------------------------------------------ situs ESPN palsu (rentang tanggal, banyak liga) */

const HOUR = 3_600_000;
export const LEAGUE_FIXTURES = {
  'soccer/eng.1': { name: 'English Premier League', teams: ['Manchester City', 'Arsenal', 'Liverpool', 'Chelsea', 'Tottenham Hotspur', 'Newcastle United', 'Aston Villa', 'Brighton & Hove Albion'] },
  'soccer/esp.1': { name: 'Spanish LALIGA', teams: ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Sevilla', 'Real Sociedad', 'Villarreal', 'Athletic Club', 'Valencia'] },
  'soccer/ger.1': { name: 'German Bundesliga', teams: ['Bayern Munich', 'Borussia Dortmund', 'RB Leipzig', 'Bayer Leverkusen', 'Eintracht Frankfurt', 'VfB Stuttgart', 'SC Freiburg', 'Werder Bremen'] },
  'basketball/nba': { name: 'National Basketball Association', teams: ['Los Angeles Lakers', 'Boston Celtics', 'Golden State Warriors', 'Miami Heat', 'Denver Nuggets', 'Milwaukee Bucks', 'Phoenix Suns', 'Dallas Mavericks'] },
  'baseball/mlb': { name: 'Major League Baseball', teams: ['New York Yankees', 'Los Angeles Dodgers', 'Boston Red Sox', 'Houston Astros', 'Atlanta Braves', 'Chicago Cubs', 'San Diego Padres', 'Seattle Mariners'] },
  'hockey/nhl': { name: 'National Hockey League', teams: ['Boston Bruins', 'Toronto Maple Leafs', 'Edmonton Oilers', 'Colorado Avalanche', 'Vegas Golden Knights', 'New York Rangers', 'Florida Panthers', 'Dallas Stars'] },
};

/**
 * ESPN palsu: per liga, ?dates=YYYYMMDD-YYYYMMDD memuat 4 laga per hari (03, 08, 13, 18 UTC) dengan skor deterministik.
 * Relatif terhadap `now`: yang sudah lewat 3 jam = selesai, yang sedang berjalan = live, sisanya belum mulai.
 * Liga di luar LEAGUE_FIXTURES dijawab kosong (200). failPaths -> 404; failAll -> galat jaringan.
 * rejectLimit: 400 untuk rentang yang memakai &limit; rejectRange: 400 untuk setiap rentang A-B (satu hari tetap dilayani);
 * badRequestPaths: 400 hanya untuk liga tertentu (slug salah).
 * singleDayOnly: meniru ESPN yang mengabaikan rentang dan hanya mengembalikan hari pertama; ?dates=YYYYMMDD (satu hari) tetap dilayani.
 */
export function fakeEspnSite({ now = Date.now(), leagues = LEAGUE_FIXTURES, failPaths = [], failAll = false, singleDayOnly = false, rejectLimit = false, rejectRange = false, badRequestPaths = [] } = {}) {
  const log = [];
  const ymdMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const impl = async (url) => {
    log.push(String(url));
    if (failAll) throw new Error('ESPN tidak bisa dihubungi');
    const m = /\/sports\/([a-z]+\/[a-z0-9._-]+)\/scoreboard\?dates=(\d{8})(?:-(\d{8}))?(&limit=\d+)?$/.exec(String(url));
    if (!m) return new Response('{}', { status: 404 });
    const [, path, a, b0, lim] = m;
    if (badRequestPaths.includes(path)) return new Response('{}', { status: 400 });
    if (b0 && (rejectRange || (rejectLimit && lim))) return new Response('{}', { status: 400 });
    const b = singleDayOnly || !b0 ? a : b0;
    if (failPaths.includes(path)) return new Response('{}', { status: 404 });
    const lg = leagues[path];
    if (!lg) return new Response(JSON.stringify({ leagues: [{ name: path }], events: [] }), { status: 200 });
    const idx = Object.keys(leagues).indexOf(path) + 1;
    const events = [];
    for (let day = ymdMs(a); day <= ymdMs(b); day += 24 * HOUR) {
      const dayNo = Math.round(day / (24 * HOUR));
      for (let k = 0; k < 4; k++) {
        const kick = day + (3 + k * 5) * HOUR;
        const n = lg.teams.length;
        const h = (dayNo * 3 + k + idx) % n;
        const aw = (h + 1 + ((dayNo + k) % (n - 1))) % n;
        const past = kick < now - 3 * HOUR;
        const liveNow = kick <= now && !past;
        const soccer = path.startsWith('soccer/');
        const ev = espnEvent({
          id: `${idx}${String(dayNo).slice(-4)}${k}`, date: kick, home: lg.teams[h], away: lg.teams[aw],
          hs: past || liveNow ? (dayNo + k + h) % (soccer ? 4 : 120) : 0, as: past || liveNow ? (dayNo + idx + aw) % (soccer ? 3 : 110) : 0,
          state: past ? 'post' : liveNow ? 'in' : 'pre',
          name: past ? 'STATUS_FULL_TIME' : liveNow ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED',
          completed: past,
          period: liveNow ? (soccer ? 1 : 2) : past ? (soccer ? 2 : 4) : 0,
          clock: liveNow ? (soccer ? `${Math.max(1, Math.round((now - kick) / 60000))}'` : '5:30') : '', clockSec: liveNow && !soccer ? 330 : null,
          venue: 'Stadion Uji',
        });
        events.push(ev);
      }
    }
    return new Response(JSON.stringify({ leagues: [{ name: lg.name }], events }), { status: 200 });
  };
  return { impl, log };
}

/** fetch gabungan untuk tes build: alamat ESPN ke ESPN palsu, sisanya ke TheSportsDB palsu. */
export const routeFetch = (espn, tsdb) => (url, init) => (/\.espn\.com/.test(String(url)) ? espn.impl(url, init) : tsdb.impl(url, init));

/** fetch tiga arah untuk tes build: ESPN, API publik tanpa kunci (publik), sisanya TheSportsDB palsu. */
export const routeFetch3 = (espn, pub, tsdb) => (url, init) => {
  const u = String(url);
  if (/\.espn\.com/.test(u)) return espn.impl(url, init);
  if (/api\.openligadb\.de|statsapi\.mlb\.com|api-web\.nhle\.com/.test(u)) return pub(url, init);
  return tsdb.impl(url, init);
};

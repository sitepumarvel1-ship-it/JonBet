// TheSportsDB palsu untuk tes build: tiap hari tiap cabang 4 laga dengan skor deterministik;
// hari ini campuran selesai / live / akan datang relatif terhadap `now`.
import { SPORTS } from '../server/sports.js';

const HOUR = 3_600_000;
const TSDB_NAME = { football: 'Soccer', futsal: 'Futsal', basketball: 'Basketball', americanfootball: 'American Football', baseball: 'Baseball', rugby: 'Rugby', icehockey: 'Ice Hockey', tennis: 'Tennis', badminton: 'Badminton', volleyball: 'Volleyball', esports: 'ESports', mma: 'Fighting' };

/** TheSportsDB palsu: tiap hari tiap cabang 4 laga dengan skor deterministik; hari ini campuran live/selesai/akan datang. */
export function fakeTsdb({ now = Date.now(), failAll = false } = {}) {
  const log = [];
  const impl = async (url) => {
    log.push(url);
    if (failAll) throw new Error('TheSportsDB tidak bisa dihubungi');
    const m = /eventsday\.php\?d=(\d{4}-\d{2}-\d{2})&s=([^&]+)/.exec(url);
    if (!m) return new Response(JSON.stringify({}), { status: 200 });
    const [, date, sportName] = m;
    const sport = decodeURIComponent(sportName);
    const sid = SPORTS.findIndex((s) => TSDB_NAME[s.id] === sport);
    if (sid < 0) return new Response(JSON.stringify({ events: null }), { status: 200 });
    const dayNo = Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
    const events = [];
    for (let k = 0; k < 4; k++) {
      const hour = 3 + k * 5; // 03, 08, 13, 18 UTC
      const kick = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
      const h = (dayNo * 7 + sid * 3 + k) % 8; const a = (h + 1 + ((dayNo + k) % 6)) % 8;
      const past = kick < now - 3 * HOUR;
      const liveNow = kick <= now && !past;
      events.push({
        idEvent: String(1000000 + dayNo * 1000 + sid * 10 + k), strSport: sport, strLeague: `Liga ${sport}`, idLeague: String(sid + 1),
        strHomeTeam: `${sport} Tim ${h}`, strAwayTeam: `${sport} Tim ${a}`,
        strTimestamp: new Date(kick).toISOString().replace('Z', ''), dateEvent: date, strTime: `${String(hour).padStart(2, '0')}:00:00`,
        intHomeScore: past || liveNow ? String((dayNo + k + h) % 4) : null, intAwayScore: past || liveNow ? String((dayNo + sid + a) % 3) : null,
        strStatus: past ? 'Match Finished' : liveNow ? '2H' : 'Not Started', strProgress: liveNow ? '63' : null,
        strHomeTeamBadge: null, strAwayTeamBadge: null, strVenue: 'Stadion',
      });
    }
    return new Response(JSON.stringify({ events }), { status: 200 });
  };
  return { impl, log };
}


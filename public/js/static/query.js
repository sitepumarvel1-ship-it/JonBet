// Penyaringan daftar pertandingan di browser (mode statis), setara dengan GET /api/matches di server.

const HOUR = 3_600_000;
const STATUS_RANK = { live: 0, upcoming: 1, finished: 2, postponed: 3, cancelled: 4 };
const STATUSES = new Set(['all', 'live', 'upcoming', 'finished']);

export class QueryError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function intParam(sp, name, def, min, max) {
  const raw = sp.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new QueryError(400, `Parameter ${name} tidak valid.`, 'bad_param');
  return n;
}

export function sportCounts(sportIds, matches) {
  const out = Object.fromEntries(sportIds.map((id) => [id, { live: 0, upcoming: 0, finished: 0 }]));
  for (const m of matches) if (out[m.sport] && out[m.sport][m.status] !== undefined) out[m.sport][m.status]++;
  return out;
}

/**
 * @param snap       isi data/matches.json: { builtAt, meta, matches }
 * @param sp         URLSearchParams dari permintaan
 * @param ctx        { now, teamKey, sportIds }
 */
export function queryMatches(snap, sp, { now, teamKey, sportIds }) {
  const parse = (v, d) => {
    if (v === null || v === '') return d;
    const ms = /^\d{9,}$/.test(v) ? Number(v) : Date.parse(v);
    if (!Number.isFinite(ms)) throw new QueryError(400, 'Parameter waktu tidak valid.', 'bad_time');
    return ms;
  };
  const from = parse(sp.get('from'), now - 12 * HOUR);
  const to = parse(sp.get('to'), now + 36 * HOUR);
  if (to < from) throw new QueryError(400, 'Rentang waktu terbalik.', 'bad_range');
  if (to - from > 9 * 24 * HOUR) throw new QueryError(400, 'Rentang waktu maksimal 9 hari.', 'range_too_big');

  const sport = sp.get('sport');
  if (sport && !sportIds.includes(sport)) throw new QueryError(400, 'Cabang olahraga tidak dikenal.', 'bad_sport');
  const status = sp.get('status') || 'all';
  if (!STATUSES.has(status)) throw new QueryError(400, 'Status tidak valid.', 'bad_status');
  const q = String(sp.get('q') || '').slice(0, 60);
  const limit = intParam(sp, 'limit', 300, 1, 500);

  const needle = teamKey(q);
  let out = snap.matches.filter((m) => {
    const k = Date.parse(m.kickoff);
    if (!(k >= from && k <= to)) return false;
    if (sport && m.sport !== sport) return false;
    if (status !== 'all' && m.status !== status) return false;
    if (needle && !teamKey(`${m.home.name} ${m.away.name} ${m.league}`).includes(needle)) return false;
    return true;
  });
  out.sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (r) return r;
    const d = Date.parse(a.kickoff) - Date.parse(b.kickoff);
    return a.status === 'finished' ? -d : d;
  });
  out = out.slice(0, limit);
  return {
    matches: out,
    meta: { ...snap.meta, updatedAt: snap.builtAt, total: out.length },
    counts: sportCounts(sportIds, out),
  };
}

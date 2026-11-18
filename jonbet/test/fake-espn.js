// Respons scoreboard ESPN palsu (bentuk mengikuti JSON publik ESPN) untuk tes sumber skor langsung.
export function espnEvent({
  id = '1', date, home, away, hs = 0, as = 0, state = 'in', name = 'STATUS_IN_PROGRESS', completed = false,
  period = 1, clock = '', clockSec = null, detail = '', homeNames, awayNames,
}) {
  const team = (display, extra) => ({ displayName: display, shortDisplayName: extra?.short ?? display, name: extra?.name ?? display, abbreviation: extra?.abbr ?? display.slice(0, 3).toUpperCase() });
  return {
    id,
    date: new Date(date).toISOString(),
    status: { clock: clockSec, displayClock: clock, period, type: { state, name, completed, shortDetail: detail } },
    competitions: [{
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

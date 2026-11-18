import { createApp } from '../server/app.js';

/** Jalankan aplikasi di port acak dengan DB memori dan data demo. */
export async function boot(opts = {}) {
  const clock = { t: opts.start ?? (process.env.JB_NOW ? Date.parse(process.env.JB_NOW) : Date.now()) };
  const app = createApp({
    dbPath: ':memory:', provider: 'demo', log: () => {},
    rateLimitPerMinute: 100000, authRateLimitPerMinute: 100000, aiRateLimitPerMinute: 100000, writeRateLimitPerMinute: 100000,
    now: () => clock.t, ...opts,
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  async function req(method, path, { body, cookie, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { h['content-type'] ??= 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, headers: res.headers, text, json, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
  }

  async function signup(name = 'user_' + Math.random().toString(36).slice(2, 8), password = 'kata-sandi-1') {
    const r = await req('POST', '/api/auth/register', { body: { username: name, password } });
    if (r.status !== 201) throw new Error(`register gagal: ${r.status} ${r.text}`);
    return { name, password, cookie: r.cookie };
  }

  async function firstMatch(status, sport) {
    const q = new URLSearchParams({ status });
    if (sport) q.set('sport', sport);
    const r = await req('GET', `/api/matches?${q}`);
    const m = r.json.matches.find((x) => !sport || x.sport === sport);
    if (!m) throw new Error(`tidak ada pertandingan ${status} ${sport || ''}`);
    return m;
  }

  return { app, base, clock, req, signup, firstMatch, close: () => app.close() };
}

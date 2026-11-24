// Aplikasi HTTP JonBet: API + berkas statis, tanpa framework.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { config as defaultConfig } from './config.js';
import { openDb } from './db.js';
import { createAuth, HttpError } from './auth.js';
import { createHistory } from './history.js';
import { createCommunity } from './community.js';
import { createService } from './service.js';
import { createDemoProvider } from './providers/demo.js';
import { createTsdbProvider } from './providers/thesportsdb.js';
import { createEspnProvider } from './providers/espn.js';
import { createPublicProvider } from './providers/publicapis.js';
import { createCompositeProvider } from './providers/composite.js';
import { SPORTS, SPORTS_BY_ID, isSport, publicSport } from './sports.js';
import { answer, suggestionsFor, DISCLAIMER } from './ai/explainer.js';
import { answerGlobal, cleanContext } from './ai/assistant.js';
import { analyze } from './model/model.js';
import { askClaude, buildContext } from './ai/llm.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.txt']);

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MATCH_ID_RE = /^(demo|tsdb|espn|pub):[A-Za-z0-9_-]{1,48}$/;
const STATUSES = new Set(['all', 'live', 'upcoming', 'finished']);
const HOUR = 3_600_000;

function makeLimiter(max, windowMs = 60_000) {
  const buckets = new Map();
  return (key) => {
    const t = Date.now();
    let e = buckets.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; buckets.set(key, e); }
    e.n++;
    if (buckets.size > 20000) for (const [k, v] of buckets) if (v.reset <= t) buckets.delete(k);
    return e.n <= max ? 0 : Math.max(1, Math.ceil((e.reset - t) / 1000));
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createApp(opts = {}) {
  const cfg = { ...defaultConfig, ...opts };
  const log = opts.log || ((...a) => console.error('[jonbet]', ...a));
  const now = opts.now || (() => Date.now());

  const db = opts.db || openDb(cfg.dbPath);
  const history = createHistory(db, { now });
  const community = createCommunity(db, { now });
  const auth = createAuth(db);

  const demo = createDemoProvider({ now });
  let primary = demo;
  let fallback = null;
  if (cfg.provider === 'thesportsdb' || cfg.provider === 'espn' || cfg.provider === 'auto') {
    // auto = ESPN (utama) + TheSportsDB (pelengkap cabang lain); espn / thesportsdb = satu sumber saja.
    primary = opts.primaryProvider || (cfg.provider === 'thesportsdb'
      ? createTsdbProvider({ key: cfg.tsdbKey, now })
      : cfg.provider === 'espn'
        ? createEspnProvider({ now, log, rugbyDiscovery: true })
        : createCompositeProvider({ primary: createEspnProvider({ now, log, rugbyDiscovery: true }), secondary: createCompositeProvider({ primary: createPublicProvider({ now, log }), secondary: createTsdbProvider({ key: cfg.tsdbKey, now }), log }), log }));
    fallback = cfg.fallbackDemo ? demo : null;
  } else if (opts.primaryProvider) {
    primary = opts.primaryProvider;
  }
  const service = createService({ primary, fallback, history, community, now, log });

  if (primary.isDemo) history.ingestMany(demo.history(30));

  const limitApi = makeLimiter(cfg.rateLimitPerMinute);
  const limitAuth = makeLimiter(cfg.authRateLimitPerMinute);
  const limitAi = makeLimiter(cfg.aiRateLimitPerMinute);
  const limitWrite = makeLimiter(cfg.writeRateLimitPerMinute);

  const allowedOrigins = new Set(String(cfg.allowedOrigins || '').split(',').map((x) => x.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));

  const aiMode = () => (cfg.anthropicKey ? 'claude' : 'builtin');

  /* ------------------------------------------------------------ helpers */

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function isSecure(req) {
    return cfg.secureCookies || !!req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  function baseHeaders(extra = {}) {
    return {
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      ...extra,
    };
  }

  function sendBuffer(req, res, status, buf, headers, compress) {
    const h = baseHeaders(headers);
    if (compress && buf.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      buf = zlib.gzipSync(buf);
      h['Content-Encoding'] = 'gzip';
      h['Vary'] = 'Accept-Encoding';
    }
    h['Content-Length'] = buf.length;
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  function sendJson(req, res, status, obj, extra = {}) {
    const buf = Buffer.from(JSON.stringify(obj));
    sendBuffer(req, res, status, buf, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, true);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '');
      const len = Number(req.headers['content-length'] || 0);
      if (len > cfg.maxBodyBytes) { reject(new HttpError(413, 'Permintaan terlalu besar.', 'too_large')); req.resume(); return; }
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        if (size > cfg.maxBodyBytes) { failed = true; reject(new HttpError(413, 'Permintaan terlalu besar.', 'too_large')); req.resume(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (failed) return;
        if (size === 0) return resolve({});
        if (!/^application\/json\b/i.test(type)) return reject(new HttpError(415, 'Gunakan Content-Type: application/json.', 'bad_type'));
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('bukan objek');
          resolve(v);
        } catch {
          reject(new HttpError(400, 'Isi permintaan bukan JSON yang valid.', 'bad_json'));
        }
      });
      req.on('error', () => reject(new HttpError(400, 'Permintaan terputus.', 'aborted')));
    });
  }

  function setSessionCookie(req, res, token, maxAgeSec) {
    const parts = [`jb_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (isSecure(req)) parts.push('Secure');
    return parts.join('; ');
  }

  function currentUser(req) {
    if (req._user !== undefined) return req._user;
    const token = parseCookies(req.headers.cookie).jb_session;
    req._user = auth.userFromToken(token);
    req._token = token;
    return req._user;
  }

  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Masuk dulu untuk melakukan ini.', 'auth_required');
    return u;
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Asal permintaan tidak valid.', 'bad_origin'); }
    const expected = (cfg.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    if (host === expected) return;
    // Alamat tampilan lain yang sengaja diizinkan (mis. tampilan di domain lain yang memanggil /api server ini).
    if (allowedOrigins.has(origin.replace(/\/+$/, '').toLowerCase())) return;
    throw new HttpError(403, 'Asal permintaan tidak diizinkan.', 'bad_origin');
  }

  function parseWindow(url) {
    const t = now();
    const parse = (v, d) => {
      if (v === null || v === '') return d;
      const ms = /^\d{9,}$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(ms)) throw new HttpError(400, 'Parameter waktu tidak valid.', 'bad_time');
      return ms;
    };
    const from = parse(url.searchParams.get('from'), t - 12 * HOUR);
    const to = parse(url.searchParams.get('to'), t + 36 * HOUR);
    if (to < from) throw new HttpError(400, 'Rentang waktu terbalik.', 'bad_range');
    if (to - from > 9 * 24 * HOUR) throw new HttpError(400, 'Rentang waktu maksimal 9 hari.', 'range_too_big');
    return { from, to };
  }

  function intParam(url, name, def, min, max) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Parameter ${name} tidak valid.`, 'bad_param');
    return n;
  }

  const matchId = (raw) => {
    let id;
    try { id = decodeURIComponent(raw); } catch { throw new HttpError(404, 'Pertandingan tidak ditemukan.', 'not_found'); }
    if (!MATCH_ID_RE.test(id)) throw new HttpError(404, 'Pertandingan tidak ditemukan.', 'not_found');
    return id;
  };

  /* ------------------------------------------------------------- rute API */

  async function api(req, res, url) {
    const method = req.method;
    const p = url.pathname;
    let m;

    if (method === 'GET' && p === '/api/health') {
      return sendJson(req, res, 200, { ok: true, ...service.health(), ai: aiMode() });
    }
    if (method === 'GET' && p === '/api/config') {
      const h = service.health();
      return sendJson(req, res, 200, {
        name: 'JonBet',
        demo: h.demo,
        provider: h.provider,
        fallbackActive: h.fallbackActive,
        ai: aiMode(),
        sports: SPORTS.map(publicSport),
        disclaimer: DISCLAIMER,
      });
    }
    if (method === 'GET' && p === '/api/matches') {
      const { from, to } = parseWindow(url);
      const sport = url.searchParams.get('sport');
      if (sport && !isSport(sport)) throw new HttpError(400, 'Cabang olahraga tidak dikenal.', 'bad_sport');
      const status = url.searchParams.get('status') || 'all';
      if (!STATUSES.has(status)) throw new HttpError(400, 'Status tidak valid.', 'bad_status');
      const q = String(url.searchParams.get('q') || '').slice(0, 60);
      const limit = intParam(url, 'limit', 300, 1, 500);
      const r = await service.list({ from, to, sports: sport ? [sport] : null, status, q, limit });
      const counts = service.sportCounts(r.matches);
      return sendJson(req, res, 200, { ...r, counts });
    }
    if (method === 'GET' && (m = /^\/api\/matches\/([^/]+)$/.exec(p))) {
      return sendJson(req, res, 200, { match: await service.get(matchId(m[1])) });
    }
    if (method === 'GET' && (m = /^\/api\/matches\/([^/]+)\/analysis$/.exec(p))) {
      return sendJson(req, res, 200, await service.analysisBundle(matchId(m[1])));
    }
    if (method === 'POST' && (m = /^\/api\/matches\/([^/]+)\/ai$/.exec(p))) {
      const wait = limitAi(clientIp(req));
      if (wait) throw new HttpError(429, `Terlalu banyak pertanyaan. Coba lagi dalam ${wait} detik.`, 'rate_limited');
      const body = await readJson(req);
      const question = String(body.message ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!question || question.length > 500) throw new HttpError(400, 'Pertanyaan harus 1 sampai 500 karakter.', 'bad_message');
      const bundle = await service.analysisBundle(matchId(m[1]));
      const sport = SPORTS_BY_ID[bundle.match.sport];
      const simulate = bundle.ratings
        ? (score, minute) => analyze({ sport: bundle.match.sport, match: { ...bundle.match, status: 'live', score, minute, period: null, progress: null }, homeStats: bundle.ratings.home, awayStats: bundle.ratings.away })
        : null;
      const args = { question, match: bundle.match, analysis: bundle.analysis, form: bundle.form, h2h: bundle.h2h, sport, context: cleanContext(body.context), simulate };

      if (cfg.anthropicKey) {
        try {
          const reply = await askClaude({
            apiKey: cfg.anthropicKey, model: cfg.anthropicModel, context: buildContext(args),
            history: Array.isArray(body.history) ? body.history : [], question, fetchImpl: opts.llmFetch,
          });
          return sendJson(req, res, 200, { reply, source: 'claude', suggestions: suggestionsFor(bundle.match, bundle.analysis) });
        } catch (err) {
          log('Claude API gagal, memakai JonBet AI bawaan:', err?.message);
          const r = answer(args);
          return sendJson(req, res, 200, { reply: r.reply, source: 'jonbet', degraded: true, suggestions: r.suggestions, context: r.context });
        }
      }
      const r = answer(args);
      return sendJson(req, res, 200, { reply: r.reply, source: 'jonbet', suggestions: r.suggestions, context: r.context });
    }
    // Asisten lintas laga: "laga live sekarang", "favorit malam ini", "jadwal basket besok"...
    if (method === 'POST' && p === '/api/ask') {
      const wait = limitAi(clientIp(req));
      if (wait) throw new HttpError(429, `Terlalu banyak pertanyaan. Coba lagi dalam ${wait} detik.`, 'rate_limited');
      const body = await readJson(req);
      const question = String(body.message ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!question || question.length > 500) throw new HttpError(400, 'Pertanyaan harus 1 sampai 500 karakter.', 'bad_message');
      const t = now();
      const r = await service.list({ from: t - 2 * 86_400_000, to: t + 8 * 86_400_000, sports: null, status: 'all', q: '', limit: 500 });
      const out = answerGlobal({ question, matches: r.matches, sports: SPORTS.map(publicSport), now: t, context: cleanContext(body.context) });
      return sendJson(req, res, 200, { reply: out.reply, source: 'jonbet', matches: out.matchIds.map((id) => r.matches.find((m) => m.id === id)).filter(Boolean), suggestions: out.suggestions, context: out.context });
    }

    /* ---- komunitas ---- */
    if (method === 'GET' && (m = /^\/api\/matches\/([^/]+)\/community$/.exec(p))) {
      const id = matchId(m[1]);
      return sendJson(req, res, 200, community.forMatch(id, currentUser(req)?.id ?? null));
    }
    if (method === 'POST' && (m = /^\/api\/matches\/([^/]+)\/predictions$/.exec(p))) {
      const user = requireUser(req);
      const wait = limitWrite(clientIp(req));
      if (wait) throw new HttpError(429, 'Terlalu cepat. Coba lagi sebentar.', 'rate_limited');
      const body = await readJson(req);
      const match = await service.get(matchId(m[1]));
      const r = community.save(user, match, body);
      return sendJson(req, res, r.updated ? 200 : 201, r);
    }
    if (method === 'DELETE' && (m = /^\/api\/predictions\/(\d{1,12})$/.exec(p))) {
      const user = requireUser(req);
      community.remove(user, Number(m[1]));
      return sendJson(req, res, 200, { ok: true });
    }
    if (method === 'POST' && (m = /^\/api\/predictions\/(\d{1,12})\/like$/.exec(p))) {
      const user = requireUser(req);
      const wait = limitWrite(clientIp(req));
      if (wait) throw new HttpError(429, 'Terlalu cepat. Coba lagi sebentar.', 'rate_limited');
      return sendJson(req, res, 200, community.toggleLike(user, Number(m[1])));
    }
    if (method === 'GET' && p === '/api/feed') {
      const sport = url.searchParams.get('sport');
      if (sport && !isSport(sport)) throw new HttpError(400, 'Cabang olahraga tidak dikenal.', 'bad_sport');
      const sort = url.searchParams.get('sort') === 'top' ? 'top' : 'new';
      const items = community.feed({
        sort, sport: sport || null, limit: intParam(url, 'limit', 30, 1, 50), offset: intParam(url, 'offset', 0, 0, 5000),
        viewerId: currentUser(req)?.id ?? null,
      });
      return sendJson(req, res, 200, { items });
    }
    if (method === 'GET' && p === '/api/leaderboard') {
      const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
      return sendJson(req, res, 200, { period, rows: community.leaderboard({ period, limit: intParam(url, 'limit', 20, 1, 100) }) });
    }
    if (method === 'GET' && (m = /^\/api\/users\/([A-Za-z0-9_]{3,20})$/.exec(p))) {
      return sendJson(req, res, 200, community.profile(m[1], currentUser(req)?.id ?? null));
    }
    if (method === 'GET' && p === '/api/model/record') {
      const sport = url.searchParams.get('sport');
      if (sport && !isSport(sport)) throw new HttpError(400, 'Cabang olahraga tidak dikenal.', 'bad_sport');
      const h = service.health();
      return sendJson(req, res, 200, { demo: h.demo, ...history.modelRecord(sport || null, h.demo ? 'demo' : 'real') });
    }

    /* ---- akun ---- */
    if (method === 'GET' && p === '/api/me') {
      const u = currentUser(req);
      return sendJson(req, res, 200, { user: u ? { id: u.id, username: u.username } : null });
    }
    if (method === 'POST' && (p === '/api/auth/register' || p === '/api/auth/login')) {
      const wait = limitAuth(clientIp(req));
      if (wait) throw new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.`, 'rate_limited');
      const body = await readJson(req);
      const r = p.endsWith('register') ? auth.register(body.username, body.password) : auth.login(body.username, body.password);
      return sendJson(req, res, p.endsWith('register') ? 201 : 200, { user: { id: r.user.id, username: r.user.username } }, {
        'Set-Cookie': setSessionCookie(req, res, r.session.token, cfg.sessionDays * 86400),
      });
    }
    if (method === 'POST' && p === '/api/auth/logout') {
      currentUser(req);
      auth.logout(req._token);
      return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': setSessionCookie(req, res, '', 0) });
    }

    throw new HttpError(404, 'Endpoint tidak ditemukan.', 'not_found');
  }

  /* ---------------------------------------------------------------- statis */

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: { message: 'Metode tidak diizinkan.', code: 'method_not_allowed' } }, { Allow: 'GET, HEAD' });
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return sendJson(req, res, 400, { error: { message: 'Alamat tidak valid.' } }); }
    if (rel.includes('\0')) return sendJson(req, res, 400, { error: { message: 'Alamat tidak valid.' } });
    if (rel.endsWith('/')) rel += 'index.html';

    let file = path.resolve(cfg.publicDir, '.' + rel);
    const inside = file === cfg.publicDir || file.startsWith(cfg.publicDir + path.sep);
    const dotfile = rel.split('/').some((seg) => seg.startsWith('.') && seg !== '');
    let stat = null;
    if (inside && !dotfile) { try { stat = fs.statSync(file); } catch { stat = null; } }
    if (!stat || !stat.isFile()) {
      // Halaman aplikasi (router di sisi klien) -> index.html. Berkas dengan ekstensi yang hilang -> 404.
      if (path.extname(rel)) return sendJson(req, res, 404, { error: { message: 'Berkas tidak ditemukan.', code: 'not_found' } });
      file = path.join(cfg.publicDir, 'index.html');
      try { stat = fs.statSync(file); } catch { return sendJson(req, res, 404, { error: { message: 'Aplikasi belum dibangun.' } }); }
    }

    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const longCache = ext === '.png' || ext === '.woff' || ext === '.woff2' || ext === '.ico';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, baseHeaders({ ETag: etag, 'Cache-Control': headers['Cache-Control'] }));
      return res.end();
    }
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    return sendBuffer(req, res, 200, fs.readFileSync(file), headers, COMPRESSIBLE.has(ext));
  }

  /* ---------------------------------------------------------------- server */

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const wait = limitApi(clientIp(req));
        if (wait) {
          return sendJson(req, res, 429, { error: { message: `Terlalu banyak permintaan. Coba lagi dalam ${wait} detik.`, code: 'rate_limited' } }, { 'Retry-After': String(wait) });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);
        if (req.method === 'HEAD') req.method = 'GET';
        return await api(req, res, url);
      }
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(req, res, err.status, { error: { message: err.message, code: err.code } });
      }
      log('galat tak terduga:', err?.stack || err);
      if (!res.headersSent) sendJson(req, res, 500, { error: { message: 'Terjadi kesalahan di server. Coba lagi.', code: 'internal' } });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  let timers = [];
  function start() {
    const run = () => service.tick().catch((e) => log('tick:', e?.message));
    run();
    timers.push(setInterval(run, 30_000));
    timers.push(setInterval(() => { try { auth.purgeExpired(); } catch { /* abaikan */ } }, 3600_000));
    for (const t of timers) t.unref();
  }

  async function listen(port = cfg.port, host = cfg.host) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    start();
    return server.address().port;
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    timers = [];
    await new Promise((r) => server.close(() => r()));
    server.closeAllConnections?.();
    try { db.close(); } catch { /* sudah tertutup */ }
  }

  return { server, listen, close, service, history, community, auth, db, config: cfg };
}

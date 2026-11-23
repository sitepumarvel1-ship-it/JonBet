// Proxy skor langsung untuk Cloudflare Workers (satu berkas, tanpa dependensi, tanpa langkah build).
//
// Tugasnya:
//   1. menyimpan kunci penyedia data berlisensi sebagai SECRET Cloudflare (tidak pernah masuk situs GitHub Pages);
//   2. memanggil penyedia, lalu mengubah responsnya ke satu bentuk JSON yang sama untuk semua penyedia;
//   3. menyimpan hasilnya beberapa detik di cache Cloudflare, sehingga 1 pengunjung atau 1.000 pengunjung memakai kuota yang sama;
//   4. hanya menjawab peramban dari asal (origin) situs kita, lewat CORS.
//
// Pengaturan (Workers > Settings > Variables and Secrets):
//   LIVE_PROVIDER    "apifootball" (sepak bola saja) atau "thesportsdb" (banyak cabang)       [teks]
//   LIVE_API_KEY     kunci dari penyedia                                                       [SECRET]
//   ALLOWED_ORIGINS  asal situs, mis. https://akmal.github.io (boleh beberapa, pisahkan koma)  [teks]
//   CACHE_SECONDS    opsional, 5-120, bawaan 15                                                [teks]
//
// Jalur:  GET /live  -> { ok, provider, label, at, events: [...] }      GET /health -> status tanpa memanggil penyedia.
//
// PENTING: bentuk respons tiap penyedia di bawah ditulis dari dokumentasinya dan diuji dengan contoh buatan sendiri;
// belum pernah dijalankan terhadap layanan aslinya dari lingkungan pengembangan. Lihat docs/DEPLOY.md bagian "Skor langsung dari server lain".

const MAX_EVENTS = 600;
const UPSTREAM_TIMEOUT_MS = 8000;
const STALE_OK_MS = 90_000; // bila penyedia sedang error, data yang masih berumur segini tetap disajikan (ditandai stale)

const str = (x, n = 80) => String(x ?? '').trim().slice(0, n);
const int = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
};
const clampInt = (x, lo, hi, def) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ API-Football (v3.football.api-sports.io) */

const AF_URL = 'https://v3.football.api-sports.io/fixtures?live=all';
const AF_IN = { '1H': 'Babak 1', HT: 'Turun minum', '2H': 'Babak 2', ET: 'Perpanjangan', BT: 'Jeda perpanjangan', P: 'Adu penalti', LIVE: 'Live', INT: 'Jeda' };
const AF_CODE = { HT: 'HT', ET: 'ET', BT: 'ET', P: 'PEN' };
const AF_POST = new Set(['FT', 'AET', 'PEN']);

export function normalizeApiFootball(json) {
  const errs = json?.errors;
  const hasErr = Array.isArray(errs) ? errs.length > 0 : errs && typeof errs === 'object' && Object.keys(errs).length > 0;
  if (hasErr) {
    const msg = Array.isArray(errs) ? errs.join('; ') : Object.values(errs).join('; ');
    throw new UpstreamError(`API-Football: ${str(msg, 140)}`);
  }
  const out = [];
  for (const r of Array.isArray(json?.response) ? json.response : []) {
    const short = str(r?.fixture?.status?.short, 8).toUpperCase();
    const state = AF_POST.has(short) ? 'post' : AF_IN[short] ? 'in' : null;
    if (!state) continue; // belum mulai, ditunda, dibatalkan, ditangguhkan: bukan urusan skor langsung
    const hs = int(r?.goals?.home);
    const as = int(r?.goals?.away);
    const home = str(r?.teams?.home?.name);
    const away = str(r?.teams?.away?.name);
    if (hs === null || as === null || !home || !away || r?.fixture?.id == null) continue;
    const kick = Date.parse(r.fixture.date);
    const elapsed = int(r.fixture.status.elapsed);
    const extra = int(r.fixture.status.extra);
    out.push({
      id: `af:${r.fixture.id}`,
      sport: 'football',
      league: str(r?.league?.name),
      kickoff: Number.isFinite(kick) ? kick : null,
      home, away, hs, as,
      state,
      code: state === 'in' ? AF_CODE[short] || '' : '',
      minute: state === 'in' && elapsed !== null ? elapsed + (extra || 0) : null,
      period: state === 'in' ? AF_IN[short] : 'Selesai',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ TheSportsDB v2 (premium) */

const TSDB_URL = 'https://www.thesportsdb.com/api/v2/json/livescore/all';
const TSDB_SPORTS = {
  soccer: 'football', football: 'football', futsal: 'futsal', basketball: 'basketball', 'american football': 'americanfootball',
  baseball: 'baseball', rugby: 'rugby', 'ice hockey': 'icehockey', tennis: 'tennis', badminton: 'badminton',
  volleyball: 'volleyball', esports: 'esports', fighting: 'mma',
};
const TSDB_DONE = new Set(['ft', 'aet', 'pen', 'finished', 'match finished', 'final', 'ended', 'after over time', 'after extra time', 'after penalties']);
const TSDB_SKIP = new Set(['', 'ns', 'not started', 'tbd', 'postponed', 'cancelled', 'canceled', 'abandoned', 'suspended', 'interrupted', 'walkover', 'awarded']);

function tsdbKickoff(r) {
  const raw = r.strTimestamp || (r.dateEvent ? `${r.dateEvent}T${r.strTime || '00:00:00'}` : '');
  if (!raw) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`); // TheSportsDB memakai UTC
  return Number.isFinite(t) ? t : null;
}

export function normalizeTsdb(json) {
  const rows = json?.livescore ?? json?.events ?? json?.results;
  if (!Array.isArray(rows)) {
    if (json && typeof json === 'object' && (json.Message || json.message || json.error)) throw new UpstreamError(`TheSportsDB: ${str(json.Message || json.message || json.error, 140)}`);
    return [];
  }
  const out = [];
  for (const r of rows) {
    const sport = TSDB_SPORTS[str(r?.strSport, 30).toLowerCase()];
    if (!sport) continue;
    const status = str(r?.strStatus, 30).toLowerCase();
    if (TSDB_SKIP.has(status)) continue;
    const state = TSDB_DONE.has(status) ? 'post' : 'in';
    const hs = int(r?.intHomeScore);
    const as = int(r?.intAwayScore);
    const home = str(r?.strHomeTeam);
    const away = str(r?.strAwayTeam);
    if (hs === null || as === null || !home || !away || !r?.idEvent) continue;
    const progress = str(r?.strProgress, 20);
    const digits = /\d+/.exec(progress);
    const ht = status === 'ht' || /half\s*time/.test(status) || /^ht$/i.test(progress);
    let minute = ht ? 45 : digits ? Number(digits[0]) : null;
    if (minute !== null && (minute < 0 || minute > 150)) minute = null;
    let period = 'Live';
    let code = '';
    if (state === 'post') period = 'Selesai';
    else if (ht) { period = 'Turun minum'; code = 'HT'; }
    else if (sport === 'football' && minute !== null) period = minute > 90 ? 'Perpanjangan' : minute <= 45 ? 'Babak 1' : 'Babak 2';
    else if (sport !== 'football') period = status && !/^(live|in progress|started|playing)$/.test(status) ? str(r.strStatus, 20) : progress || 'Live'; // label babak (Q2, Set 3...); strProgress bisa berarti sisa waktu
    out.push({
      id: `ts:${r.idEvent}`,
      sport,
      league: str(r?.strLeague),
      kickoff: tsdbKickoff(r),
      home, away, hs, as,
      state,
      code,
      minute: state === 'in' && sport === 'football' ? minute : null, // menit hanya bermakna untuk sepak bola; cabang lain memakai label babak
      period,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ penyedia */

export const PROVIDERS = {
  apifootball: {
    label: 'API-Football',
    url: AF_URL,
    headers: (key) => ({ 'x-apisports-key': key, accept: 'application/json' }),
    normalize: normalizeApiFootball,
  },
  thesportsdb: {
    label: 'TheSportsDB',
    url: TSDB_URL,
    headers: (key) => ({ 'X-API-KEY': key, accept: 'application/json' }),
    normalize: normalizeTsdb,
  },
};

async function callProvider(p, key, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(p.url, { headers: p.headers(key), signal: ctl.signal });
  } catch (e) {
    throw new UpstreamError(e?.name === 'AbortError' ? `${p.label} tidak merespons tepat waktu.` : `${p.label} tidak dapat dihubungi.`, 504);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new UpstreamError(`${p.label} menolak permintaan (HTTP ${res.status}).`, res.status === 429 ? 429 : 502);
  let json;
  try { json = await res.json(); } catch { throw new UpstreamError(`${p.label} mengirim respons yang tidak terbaca.`); }
  return p.normalize(json).slice(0, MAX_EVENTS);
}

/* ------------------------------------------------------------------ penangan permintaan */

const parseOrigins = (raw) => String(raw || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

/**
 * @param {{fetchImpl?: typeof fetch, now?: () => number, cache?: {match(k: string): Promise<Response|undefined>, put(k: string, r: Response): Promise<void>}|null}} deps
 */
export function createHandler({ fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), cache = null } = {}) {
  let last = null; // salinan terakhir yang berhasil, per isolate: cadangan saat penyedia error

  return async function handle(request, env = {}, ctx = null) {
    const origins = parseOrigins(env.ALLOWED_ORIGINS);
    const origin = request.headers.get('Origin');
    const cors = {};
    if (origin) {
      if (!origins.includes(origin.replace(/\/+$/, ''))) return json({ ok: false, error: 'Asal tidak diizinkan.' }, 403);
      cors['Access-Control-Allow-Origin'] = origin;
      cors.Vary = 'Origin';
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'GET') return json({ ok: false, error: 'Hanya GET.' }, 405, cors);

    const { pathname } = new URL(request.url);
    const providerId = str(env.LIVE_PROVIDER, 20).toLowerCase();
    const provider = PROVIDERS[providerId];
    const key = str(env.LIVE_API_KEY, 200);
    const configured = !!provider && !!key && origins.length > 0;

    if (pathname === '/health') return json({ ok: true, configured, provider: provider ? providerId : null, originsSet: origins.length > 0, keySet: !!key }, 200, cors);
    if (pathname !== '/live' && pathname !== '/') return json({ ok: false, error: 'Tidak ditemukan.' }, 404, cors);
    if (!configured) return json({ ok: false, error: 'Proxy belum dikonfigurasi (LIVE_PROVIDER, LIVE_API_KEY, ALLOWED_ORIGINS).' }, 500, cors);

    const ttl = clampInt(env.CACHE_SECONDS, 5, 120, 15);
    const t = now();
    const cacheKey = `https://jonbet-live.invalid/${providerId}`;

    // 1) cache bersama di Cloudflare (berlaku lintas isolate dan lintas pengunjung)
    let payload = null;
    if (cache) {
      try {
        const hit = await cache.match(cacheKey);
        const cached = hit ? await hit.json() : null;
        if (cached && typeof cached.at === 'number' && t - cached.at < ttl * 1000) payload = cached;
      } catch { /* cache bermasalah: lanjut ke penyedia */ }
    }
    if (!payload && last && last.provider === providerId && t - last.at < ttl * 1000) payload = last;

    // 2) penyedia
    if (!payload) {
      try {
        const events = await callProvider(provider, key, fetchImpl);
        payload = { ok: true, provider: providerId, label: provider.label, at: t, events };
        last = payload;
        if (cache) {
          const put = cache.put(cacheKey, new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } })).catch(() => {});
          if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
        }
      } catch (e) {
        if (last && last.provider === providerId && t - last.at < STALE_OK_MS) payload = { ...last, stale: true };
        else {
          const status = e instanceof UpstreamError ? e.status : 502;
          const msg = e instanceof UpstreamError ? e.message : 'Gangguan tak terduga di proxy.';
          return json({ ok: false, error: msg.split(key).join('***') }, status === 429 ? 429 : 502, cors);
        }
      }
    }
    return json(payload, 200, { ...cors, 'Cache-Control': `public, max-age=${ttl}` });
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers } });
}

// Titik masuk Cloudflare Workers.
const handler = createHandler({ cache: typeof caches !== 'undefined' ? caches.default : null });
export default { fetch: (request, env, ctx) => handler(request, env, ctx) };

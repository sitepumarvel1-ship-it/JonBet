// "Server" mini di dalam browser untuk mode statis: menjawab permintaan /api/... yang sama seperti server,
// dari berkas data hasil build, model di browser, dan komunitas lokal.
import { ApiError } from '../api.js';
import * as data from './data.js';
import { QueryError, queryMatches } from './query.js';
import { LocalError, createLocalCommunity } from './local-community.js';

/* ---- skor langsung: dimulai di latar saat pertama dibutuhkan; tanpa itu aplikasi tetap jalan dari snapshot ---- */
let feed = null; // pemantau aktif (atau null)
let feedStarted = false;
function startLive() {
  if (feedStarted) return;
  feedStarted = true;
  (async () => {
    try {
      const cfg = await data.config();
      if (cfg.demo) return; // liga fiktif: tidak ada yang bisa ditanyakan ke ESPN
      const [model, ai, live] = await Promise.all([import('../shared/model/model.js'), import('../shared/ai/explainer.js'), import('./live.js')]);
      const f = live.createLiveFeed({
        getSnapshot: data.matches,
        getBundle: data.bundle,
        sportOf: (id) => cfg.sports.find((s) => s.id === id) || null,
        model: { analyze: model.analyze, pickOf: model.pickOf },
        explain: ai.explain,
        onChange: () => document.dispatchEvent(new CustomEvent('jb:live')),
        visible: () => document.visibilityState === 'visible',
        online: () => navigator.onLine,
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') f.poke(); });
      window.addEventListener('online', () => f.poke());
      feed = f;
      f.start();
    } catch { /* modul belum tersedia / peramban lama: lanjut tanpa skor langsung */ }
  })();
}

let local = null;
function community(sportOf) {
  if (!local) {
    let storage = null;
    try { storage = window.localStorage; } catch { storage = null; }
    local = createLocalCommunity({ storage, sportOf });
  }
  return local;
}

const toApiError = (e) => (e instanceof QueryError || e instanceof LocalError ? new ApiError(e.message, e.status, e.code) : e);
const notFound = () => new ApiError('Endpoint tidak ditemukan.', 404, 'not_found');
const decode = (s) => { try { return decodeURIComponent(s); } catch { throw new ApiError('Pertandingan tidak ditemukan.', 404, 'not_found'); } };
const intParam = (sp, name, def, min, max) => {
  const raw = sp.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(`Parameter ${name} tidak valid.`, 400, 'bad_param');
  return n;
};

let lastSettle = 0;
async function settlePending(lc) {
  if (Date.now() - lastSettle < 30_000 || !lc.hasPending()) return;
  lastSettle = Date.now();
  try {
    const [snap, res] = await Promise.all([data.matches(), data.results().catch(() => null)]);
    const byId = new Map(snap.matches.map((m) => [m.id, m]));
    const cancelled = new Set(res?.cancelled || []);
    lc.settle((id) => {
      const m = byId.get(id);
      if (m?.status === 'finished' && m.score) return { status: 'finished', score: m.score };
      if (m?.status === 'cancelled' || cancelled.has(id)) return { status: 'cancelled' };
      const r = res?.finished?.[id];
      return r ? { status: 'finished', score: { home: r[0], away: r[1] } } : null;
    });
  } catch { /* offline atau data belum siap: dicoba lagi nanti */ }
}

export async function handle(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://static.local');
  const p = url.pathname;
  const sp = url.searchParams;
  let m;
  try {
    // Pemeriksa koneksi: selalu ke jaringan (tanpa memo) supaya "Coba lagi" tidak berhasil palsu saat offline.
    if (method === 'GET' && p === '/api/health') return await data.getJson('meta.json');

    if (method === 'GET' && p === '/api/config') {
      const [cfg, mt] = await Promise.all([data.config(), data.meta()]);
      startLive();
      return { ...cfg, static: true, updatedAt: mt.builtAt, stale: !!mt.stale, live: feed ? feed.status() : null };
    }

    if (method === 'GET' && p === '/api/matches') {
      const [snap, cfg] = await Promise.all([data.matches(), data.config()]);
      const { teamKey } = await import('../shared/util.js');
      startLive();
      // Overlay dipasang sebelum penyaringan, supaya laga yang baru jadi live ikut muncul di filter "Live".
      return queryMatches(feed ? feed.applyList(snap) : snap, sp, { now: Date.now(), teamKey, sportIds: cfg.sports.map((s) => s.id) });
    }

    if (method === 'GET' && (m = /^\/api\/matches\/([^/]+)\/analysis$/.exec(p))) {
      const b = await data.bundle(decode(m[1]));
      startLive();
      return feed ? feed.applyBundle(b) : b;
    }

    if (method === 'POST' && (m = /^\/api\/matches\/([^/]+)\/ai$/.exec(p))) {
      const question = String(body?.message ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!question || question.length > 500) throw new ApiError('Pertanyaan harus 1 sampai 500 karakter.', 400, 'bad_message');
      const [raw, cfg, { answer }] = await Promise.all([data.bundle(decode(m[1])), data.config(), import('../shared/ai/explainer.js')]);
      const b = feed ? feed.applyBundle(raw) : raw; // JonBet AI menjawab dari skor terkini, bukan skor snapshot
      const sport = cfg.sports.find((s) => s.id === b.match.sport);
      const input = { question, match: b.match, analysis: b.analysis, form: b.form, h2h: b.h2h, sport };
      const r = answer(input);
      // Bila pengguna memasukkan kunci Claude sendiri: Claude menjawab dari angka analisis; gagal apa pun -> model bawaan.
      const { getClaude } = await import('./claude.js');
      const cl = getClaude();
      if (cl) {
        try {
          const llm = await import('../shared/ai/llm.js');
          const reply = await llm.askClaude({ apiKey: cl.key, model: cl.model, context: llm.buildContext(input), history: Array.isArray(body?.history) ? body.history : [], question, browser: true });
          return { reply, source: 'claude', suggestions: r.suggestions };
        } catch (err) {
          return { reply: r.reply, source: 'jonbet', degraded: true, degradedReason: /HTTP 401|HTTP 403/.test(String(err?.message)) ? 'kunci' : 'umum', suggestions: r.suggestions };
        }
      }
      return { reply: r.reply, source: 'jonbet', suggestions: r.suggestions };
    }

    if (method === 'GET' && p === '/api/model/record') {
      const rec = await data.record();
      const sport = sp.get('sport');
      if (sport && !rec.sports?.[sport]) throw new ApiError('Cabang olahraga tidak dikenal.', 400, 'bad_sport');
      return { demo: rec.demo, ...(sport ? rec.sports[sport] : rec.all) };
    }

    /* ---- komunitas lokal ---- */
    const cfgForLocal = async () => (await data.config()).sports;
    const lcOf = async () => {
      const sports = await cfgForLocal().catch(() => []);
      return community((id) => sports.find((s) => s.id === id) || null);
    };

    if (method === 'GET' && p === '/api/me') return (await lcOf()).me();
    if (method === 'POST' && p === '/api/auth/register') return (await lcOf()).register(String(body?.username ?? '').trim());
    if (method === 'POST' && p === '/api/auth/login') return (await lcOf()).login(String(body?.username ?? '').trim());
    if (method === 'POST' && p === '/api/auth/logout') return (await lcOf()).logout();

    if (method === 'GET' && (m = /^\/api\/matches\/([^/]+)\/community$/.exec(p))) {
      const lc = await lcOf();
      await settlePending(lc);
      return lc.forMatch(decode(m[1]));
    }
    if (method === 'POST' && (m = /^\/api\/matches\/([^/]+)\/predictions$/.exec(p))) {
      const lc = await lcOf();
      const b = await data.bundle(decode(m[1]));
      return lc.save(b.match, body);
    }
    if (method === 'DELETE' && (m = /^\/api\/predictions\/(\d{1,12})$/.exec(p))) {
      (await lcOf()).remove(Number(m[1]));
      return { ok: true };
    }
    if (method === 'POST' && (m = /^\/api\/predictions\/(\d{1,12})\/like$/.exec(p))) {
      return (await lcOf()).toggleLike(Number(m[1]));
    }
    if (method === 'GET' && p === '/api/feed') {
      const lc = await lcOf();
      await settlePending(lc);
      const sport = sp.get('sport');
      return { items: lc.feed({ sort: sp.get('sort') === 'top' ? 'top' : 'new', sport: sport || null, limit: intParam(sp, 'limit', 30, 1, 50), offset: intParam(sp, 'offset', 0, 0, 5000) }) };
    }
    if (method === 'GET' && p === '/api/leaderboard') {
      const lc = await lcOf();
      await settlePending(lc);
      const period = sp.get('period') === 'week' ? 'week' : 'all';
      return { period, rows: lc.leaderboard({ period, limit: intParam(sp, 'limit', 20, 1, 100) }) };
    }
    if (method === 'GET' && (m = /^\/api\/users\/([A-Za-z0-9_]{3,20})$/.exec(p))) {
      const lc = await lcOf();
      await settlePending(lc);
      return lc.profile(m[1]);
    }
  } catch (e) {
    throw toApiError(e);
  }
  throw notFound();
}

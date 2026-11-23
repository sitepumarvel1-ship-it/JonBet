// Pembaruan skor langsung di browser (mode statis).
//
// Snapshot dari build hanya segar sampai beberapa menit lalu. Untuk laga yang sedang (atau hampir) berlangsung,
// modul ini menanyakan skor ke ESPN langsung dari browser tiap ±20 detik, mencocokkannya dengan laga di snapshot,
// lalu menimpa status/skor/menit dan menghitung ulang peluang dengan model yang sama (js/shared/model).
// Bila situs diberi alamat proxy (data/config.json: liveUrl), proxy milik sendiri di depan penyedia data berlisensi ikut ditanya
// setiap putaran dan, untuk laga yang dikenalnya, mengalahkan ESPN. Tanpa proxy, perilakunya sama seperti sebelumnya.
// Laga yang tidak ditemukan di sumber mana pun tetap memakai data snapshot, dan ditandai begitu di tampilan.
//
// Semua dependensi disuntikkan (jaringan, jam, model) supaya modul ini bisa diuji di Node tanpa browser.
import { endpointsFor, overlayOf, parseScoreboard, pickEvent, scoreboardUrl } from './espn.js';
import { overlayFromProxy, parseProxy } from './proxy.js';

const MINUTE = 60_000;
const SOON_MS = 20 * MINUTE; // laga yang akan mulai dalam 20 menit sudah dipantau
const LATE_MS = 4.5 * 60 * MINUTE; // laga "upcoming" di snapshot tetapi jam mulainya sudah lewat sejauh ini tetap dipantau
const LIVE_TTL_MS = 3 * MINUTE; // overlay live yang tidak tersegarkan selama ini dibuang (lebih baik data snapshot daripada skor beku)
const FRESH_MS = 90_000; // batas "sumber langsung sehat"

export function createLiveFeed({
  getSnapshot,
  getBundle,
  sportOf = () => null,
  proxyUrl = null, // alamat proxy skor langsung (https) atau null
  model, // { analyze, pickOf }
  explain,
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  onChange = () => {},
  onEvent = () => {}, // gol, mulai, selesai (untuk notifikasi); dipanggil sekali per kejadian
  visible = () => true,
  hiddenOk = () => false, // true: tetap bertanya (lebih jarang) walau tab tersembunyi, mis. ada laga yang diikuti

  online = () => true,
  maxEndpoints = 6,
  timeoutMs = 6000,
  intervals = { live: 20_000, soon: 40_000, idle: 60_000, hidden: 60_000 },
}) {
  const overlays = new Map(); // id -> { status, score, minute, period, progress, espnId, src, at }
  const derived = new Map(); // id -> { sig, forecast }
  const bundles = new Map(); // id -> { builtAt, bundle }
  const cooldown = new Map(); // path -> { until, fails }
  const lastPolled = new Map(); // path -> waktu
  const seen = new Map(); // id -> { status, home, away }: skor/status tertinggi yang sudah diamati (dasar deteksi gol)
  let touched = new Set(); // id yang overlay-nya diperbarui pada putaran ini
  const stats = { wanted: 0, polled: 0, lastOkAt: null, proxyOkAt: null, hadLive: false, failCycles: 0 };
  let snapBuiltAt = 0;
  let busy = false;
  let timer = null;
  let running = false;
  let lastState = null;

  const sigOf = (ov) => `${ov.status}|${ov.score.home}-${ov.score.away}|${ov.minute ?? ''}|${ov.period ?? ''}|${ov.progress === null ? '' : Math.round(ov.progress * 100)}`;

  function valid(m, ov, t = now()) {
    if (!ov) return false;
    if (m.status === 'finished' || m.status === 'cancelled' || m.status === 'postponed') return false;
    // Jam peramban dan jam build bisa berbeda, jadi umur overlay hanya dibandingkan dengan jam peramban sendiri.
    return !(ov.status === 'live' && t - ov.at > LIVE_TTL_MS);
  }

  const merge = (m, ov) => ({
    ...m,
    status: ov.status,
    score: { ...ov.score },
    minute: ov.minute,
    period: ov.period,
    progress: ov.progress,
    liveSrc: { name: ov.src || 'ESPN', at: ov.at },
  });

  function forecastOf(a) {
    const p = a.current.probs;
    const pk = model.pickOf(p, a.drawable);
    return { home: p.home, draw: p.draw, away: p.away, pick: pk.side, pickP: pk.p, confidence: a.confidence.score, live: !!a.live };
  }

  const isWanted = (m, t) => {
    const ov = overlays.get(m.id);
    if (ov && ov.status === 'finished' && valid(m, ov, t)) return false; // sudah selesai: tak perlu ditanya lagi
    if (m.status === 'live') return true;
    if (m.status !== 'upcoming') return false;
    const k = Date.parse(m.kickoff);
    return k - t <= SOON_MS && t - k <= LATE_MS;
  };

  /* ---------------------------------------------------------------- jaringan */

  async function poll(ep) {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(scoreboardUrl(ep), { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return parseScoreboard(await res.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async function pollProxy() {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // GET tanpa header khusus: tidak memicu preflight CORS.
      const res = await fetchImpl(proxyUrl, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return parseProxy(await res.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Pasang overlay dan laporkan apakah tampilannya berubah. */
  function setOverlay(m, ov, t, src) {
    const prev = overlays.get(m.id);
    const next = { ...ov, src, at: t };
    overlays.set(m.id, next);
    touched.add(m.id);
    return !prev || sigOf(prev) !== sigOf(next);
  }

  function penalize(path, err, t) {
    const prev = cooldown.get(path)?.fails || 0;
    const fails = prev + 1;
    // 400/404: slug liga tidak ada di ESPN, jangan ditanya terus (tetapi dicoba lagi sesekali, siapa tahu hanya gangguan sesaat).
    // Gangguan lain: mundur bertahap, maksimal 5 menit.
    const wait = err?.status === 400 || err?.status === 404 ? 15 * MINUTE : Math.min(5 * MINUTE, 20_000 * 2 ** (fails - 1));
    cooldown.set(path, { until: t + wait, fails });
  }

  async function ensureDerived(m) {
    const ov = overlays.get(m.id);
    if (!ov) return;
    let b = bundles.get(m.id);
    if (!b || b.builtAt !== snapBuiltAt) {
      try {
        b = { builtAt: snapBuiltAt, bundle: await getBundle(m.id) };
      } catch {
        return; // peluang lama tetap dipakai
      }
      bundles.set(m.id, b);
    }
    const r = b.bundle?.ratings;
    if (!r) return;
    const a = model.analyze({ sport: m.sport, match: merge(m, ov), homeStats: r.home, awayStats: r.away });
    derived.set(m.id, { sig: sigOf(ov), forecast: forecastOf(a) });
  }

  /** Satu putaran: tanya ESPN untuk laga yang relevan, perbarui overlay. */
  async function tick() {
    if (busy) return { skipped: 'busy' };
    if (!(visible() || hiddenOk()) || !online()) return { skipped: 'hidden' };
    busy = true;
    try {
      const snap = await getSnapshot();
      snapBuiltAt = Date.parse(snap.builtAt) || 0;
      const t = now();
      const wanted = snap.matches.filter((m) => isWanted(m, t));
      stats.wanted = wanted.length;
      stats.hadLive = wanted.some((m) => m.status === 'live');

      const groups = new Map();
      for (const m of wanted) {
        for (const ep of endpointsFor(m)) {
          if ((cooldown.get(ep.path)?.until || 0) > t) continue;
          if (!groups.has(ep.path)) groups.set(ep.path, { ep, matches: [] });
          groups.get(ep.path).matches.push(m);
        }
      }
      // Yang paling lama tidak ditanya didahulukan, lalu yang paling banyak laganya.
      const chosen = [...groups.values()]
        .sort((a, b) => (lastPolled.get(a.ep.path) || 0) - (lastPolled.get(b.ep.path) || 0) || b.matches.length - a.matches.length)
        .slice(0, maxEndpoints);
      stats.polled = chosen.length;

      const askProxy = !!proxyUrl && wanted.length > 0 && (cooldown.get('proxy')?.until || 0) <= t;
      const [results, proxyRes] = await Promise.all([
        Promise.allSettled(chosen.map((g) => poll(g.ep))),
        askProxy ? pollProxy().then((value) => ({ value }), (reason) => ({ reason })) : null,
      ]);
      const changedIds = [];
      let ok = 0;
      results.forEach((r, i) => {
        const g = chosen[i];
        lastPolled.set(g.ep.path, t);
        if (r.status === 'rejected') { penalize(g.ep.path, r.reason, t); return; }
        ok++;
        cooldown.delete(g.ep.path);
        for (const m of g.matches) {
          const hit = pickEvent(m, r.value);
          const ov = hit && overlayOf(m, hit.ev, hit.swapped);
          if (!ov) continue;
          if (setOverlay(m, ov, t, 'ESPN')) changedIds.push(m.id);
        }
      });
      // Proxy dipasang terakhir supaya skornya menimpa ESPN untuk laga yang dikenalnya.
      if (proxyRes) {
        if (proxyRes.reason) penalize('proxy', proxyRes.reason, t);
        else if (!proxyRes.value.stale) {
          cooldown.delete('proxy');
          ok++;
          stats.proxyOkAt = t;
          for (const m of wanted) {
            const ov = overlayFromProxy(m, proxyRes.value.events);
            if (ov && setOverlay(m, ov, t, proxyRes.value.label)) changedIds.push(m.id);
          }
        }
      }
      if (ok) { stats.lastOkAt = t; stats.failCycles = 0; } else if (chosen.length || proxyRes) stats.failCycles++;

      const byId = new Map(snap.matches.map((m) => [m.id, m]));
      detectEvents(byId, t);
      for (const id of [...new Set(changedIds)].slice(0, 40)) {
        const m = byId.get(id);
        if (m) await ensureDerived(m);
      }
      const state = status().state;
      if (changedIds.length || state !== lastState) { lastState = state; onChange(); }
      return { polled: chosen.length, ok, changed: changedIds.length };
    } finally {
      busy = false;
    }
  }

  /**
   * Kejadian dideteksi setelah semua sumber putaran ini dipasang (bukan per sumber), dibandingkan dengan skor tertinggi yang pernah diamati,
   * jadi dua sumber yang berselisih sesaat tidak menghasilkan "gol" ganda. Pengamatan pertama hanya menjadi dasar; satu-satunya kejadian
   * yang dilaporkan dari pengamatan pertama adalah "mulai", dan hanya bila laga baru saja mulai.
   */
  function detectEvents(byId, t) {
    const ids = [...touched];
    touched = new Set();
    for (const id of ids) {
      const m = byId.get(id);
      const ov = overlays.get(id);
      if (!m || !ov) continue;
      const prev = seen.get(id);
      const cur = { status: ov.status, home: ov.score.home, away: ov.score.away };
      const emit = (type, side = null) => {
        try { onEvent({ type, match: m, score: { home: cur.home, away: cur.away }, side, minute: ov.minute, period: ov.period, src: ov.src || 'ESPN', at: t }); } catch { /* pendengar bermasalah tidak boleh mengganggu pemantauan */ }
      };
      if (!prev) {
        seen.set(id, cur);
        if (ov.status === 'live' && m.status === 'upcoming' && (ov.minute === null || ov.minute <= 3)) emit('start');
        continue;
      }
      if (prev.status !== 'finished') {
        for (const [key, side] of [['home', 'H'], ['away', 'A']]) if (cur[key] > prev[key]) emit('goal', side); // gol terakhir sebelum peluit akhir tetap dilaporkan
        if (ov.status === 'finished') emit('end');
      }
      seen.set(id, { status: prev.status === 'finished' || ov.status === 'finished' ? 'finished' : 'live', home: Math.max(prev.home, cur.home), away: Math.max(prev.away, cur.away) });
    }
  }

  /* ---------------------------------------------------------------- penerapan ke data */

  /** Snapshot dengan overlay terpasang (objek baru; masukan tidak diubah). */
  function applyList(snap) {
    const t = now();
    const builtAt = Date.parse(snap.builtAt);
    if (Number.isFinite(builtAt)) snapBuiltAt = builtAt;
    let touched = false;
    const matches = snap.matches.map((m) => {
      const ov = overlays.get(m.id);
      if (!valid(m, ov, t)) return m;
      touched = true;
      const d = derived.get(m.id);
      const out = merge(m, ov);
      if (d) out.forecast = d.forecast;
      return out;
    });
    return touched ? { ...snap, matches } : snap;
  }

  /** Bundel analisis dengan overlay terpasang; peluang dan ringkasan dihitung ulang dari skor sekarang. */
  function applyBundle(bundle) {
    const m = bundle?.match;
    if (!m) return bundle;
    if (bundle.ratings) bundles.set(m.id, { builtAt: snapBuiltAt, bundle });
    const ov = overlays.get(m.id);
    if (!valid(m, ov) || !bundle.ratings) return bundle;
    const merged = merge(m, ov);
    try {
      const analysis = model.analyze({ sport: m.sport, match: merged, homeStats: bundle.ratings.home, awayStats: bundle.ratings.away });
      const summary = explain({ match: merged, analysis, form: bundle.form, h2h: bundle.h2h, sport: sportOf(m.sport) });
      return { ...bundle, match: merged, analysis, summary };
    } catch {
      return bundle; // jangan merusak halaman karena satu hitungan gagal
    }
  }

  /* ---------------------------------------------------------------- status dan siklus */

  function status() {
    const t = now();
    let covered = 0;
    for (const ov of overlays.values()) if (ov.status === 'live' && t - ov.at <= LIVE_TTL_MS) covered++;
    let state = 'idle';
    if (stats.failCycles >= 2) state = 'down';
    else if (stats.lastOkAt && t - stats.lastOkAt <= FRESH_MS && covered > 0) state = 'live';
    return { state, covered, wanted: stats.wanted, lastOkAt: stats.lastOkAt, proxyOkAt: stats.proxyOkAt };
  }

  const nextDelay = () => {
    const d = stats.hadLive ? intervals.live : stats.wanted > 0 ? intervals.soon : intervals.idle;
    return visible() ? d : Math.max(d, intervals.hidden ?? 60_000); // tab tersembunyi: lebih jarang (browser juga membatasi timer)
  };

  function loop() {
    if (!running) return;
    timer = setTimeout(async () => {
      try { await tick(); } catch { /* jaringan/data bermasalah: coba lagi di putaran berikutnya */ }
      loop();
    }, nextDelay());
  }

  return {
    tick,
    applyList,
    applyBundle,
    status,
    overlayOf: (id) => overlays.get(id) || null,
    start() {
      if (running) return;
      running = true;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { await tick(); } catch { /* lihat di atas */ }
        loop();
      }, 800);
    },
    /** Putar sekarang (mis. tab kembali terlihat) kecuali baru saja jalan. */
    poke() {
      if (!running || busy) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { await tick(); } catch { /* lihat di atas */ }
        loop();
      }, 50);
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}

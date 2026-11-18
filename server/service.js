// Layanan pertandingan: mengambil data dari penyedia, menangani gangguan (data lama / cadangan demo),
// mencatat hasil ke riwayat, menyelesaikan tebakan, dan menyusun paket analisis.

import { HttpError } from './auth.js';
import { SPORTS, SPORTS_BY_ID } from './sports.js';
import { teamKey } from './util.js';
import { pickOf } from './model/model.js';
import { explain } from './ai/explainer.js';

const HOUR = 3_600_000;
const STATUS_RANK = { live: 0, upcoming: 1, finished: 2, postponed: 3, cancelled: 4 };

export function createService({ primary, fallback, history, community, now = () => Date.now(), log = () => {} }) {
  const providers = new Map();
  for (const p of [primary, fallback]) if (p) providers.set(p.name, p);

  const memo = new Map(); // key -> {at, value}
  const lastGood = new Map(); // key -> value
  const state = { lastOkAt: null, lastError: null, fallbackActive: false, ticks: 0 };
  let fallbackWarm = false;

  /** Cadangan demo perlu riwayat agar model punya rating yang bermakna. */
  function warmFallback() {
    if (fallbackWarm || !fallback?.history) return;
    fallbackWarm = true;
    history.ingestMany(fallback.history(30));
  }

  async function fetchList(args) {
    const sportsKey = (args.sports || []).join(',');
    // Jendela waktu bergeser setiap milidetik; untuk memo cukup dikelompokkan per 10 detik.
    const key = `${sportsKey}|${Math.floor(args.from / 10_000)}|${Math.floor(args.to / 10_000)}`;
    const hit = memo.get(key);
    if (hit && now() - hit.at < 5000) return hit.value;

    let value;
    try {
      const matches = await primary.listMatches(args);
      value = { matches, meta: { source: primary.name, demo: primary.isDemo, stale: false, fallback: false } };
      state.lastOkAt = now();
      state.lastError = null;
      state.fallbackActive = false;
      lastGood.set(sportsKey, { from: args.from, to: args.to, value });
    } catch (err) {
      state.lastError = String(err?.message || err);
      log('sumber data gagal:', state.lastError);
      const lg = lastGood.get(sportsKey);
      // Data lama dipakai bila jendelanya masih (hampir) mencakup permintaan ini.
      if (lg && lg.from <= args.from + 3 * HOUR && lg.to >= args.to - 3 * HOUR) {
        const inWin = lg.value.matches.filter((m) => { const k = Date.parse(m.kickoff); return k >= args.from && k <= args.to; });
        value = { matches: inWin, meta: { ...lg.value.meta, stale: true } };
      } else if (fallback && fallback !== primary) {
        state.fallbackActive = true;
        warmFallback();
        const matches = await fallback.listMatches(args);
        value = { matches, meta: { source: fallback.name, demo: true, stale: false, fallback: true } };
      } else {
        throw new HttpError(502, 'Sumber data pertandingan sedang tidak bisa dihubungi. Coba lagi sebentar.', 'upstream');
      }
    }

    memo.set(key, { at: now(), value });
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    postProcess(value.matches);
    return value;
  }

  /** Catat hasil ke riwayat dan nilai tebakan yang menunggu. */
  function postProcess(matches) {
    for (const m of matches) {
      if (m.status === 'finished') {
        history.ingestResult(m);
        community.settle(m);
      } else if (m.status === 'cancelled') {
        community.settle(m);
      }
    }
  }

  function forecastOf(m) {
    const a = history.analyzeMatch(m);
    const p = a.current.probs;
    const pk = pickOf(p, a.drawable);
    return {
      home: p.home, draw: p.draw, away: p.away,
      pick: pk.side, pickP: pk.p,
      confidence: a.confidence.score,
      live: !!a.live,
    };
  }

  async function list({ from, to, sports = null, status = 'all', q = '', limit = 300 }) {
    const { matches, meta } = await fetchList({ from, to, sports });
    const needle = teamKey(q);
    let out = matches.filter((m) => (status === 'all' || m.status === status));
    if (needle) out = out.filter((m) => teamKey(`${m.home.name} ${m.away.name} ${m.league}`).includes(needle));
    out.sort((a, b) => {
      const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (r) return r;
      const d = Date.parse(a.kickoff) - Date.parse(b.kickoff);
      return a.status === 'finished' ? -d : d;
    });
    out = out.slice(0, limit).map((m) => ({ ...m, events: undefined, stats: undefined, forecast: forecastOf(m) }));
    return { matches: out, meta: { ...meta, updatedAt: new Date(now()).toISOString(), total: out.length } };
  }

  async function get(id) {
    const prefix = String(id).split(':')[0];
    // demo -> penyedia demo; tsdb/espn -> penyedia utama (penyedia gabungan meneruskan sesuai awalan id).
    const provider = prefix === 'demo' ? providers.get('demo') : (prefix === 'tsdb' || prefix === 'espn') && primary && !primary.isDemo ? primary : null;
    if (!provider) throw new HttpError(404, 'Pertandingan tidak ditemukan.', 'not_found');
    let m;
    try {
      m = await provider.getMatch(id);
    } catch (err) {
      log('getMatch gagal:', err?.message);
      throw new HttpError(502, 'Sumber data pertandingan sedang tidak bisa dihubungi.', 'upstream');
    }
    if (!m) throw new HttpError(404, 'Pertandingan tidak ditemukan.', 'not_found');
    postProcess([m]);
    return m;
  }

  /** Paket analisis lengkap dari objek pertandingan yang sudah ada (tanpa permintaan ke sumber data). */
  function bundleOf(match) {
    const analysis = history.analyzeMatch(match);
    history.recordLivePick(match, analysis);
    const form = {
      home: history.formOf(match.sport, match.home.name),
      away: history.formOf(match.sport, match.away.name),
    };
    const h2h = history.h2hOf(match.sport, match.home.name, match.away.name);
    const sport = SPORTS_BY_ID[match.sport];
    const summary = explain({ match, analysis, form, h2h, sport });
    return {
      match,
      analysis,
      form,
      h2h,
      summary,
      ratings: {
        home: history.statsFor(match.sport, match.home.name),
        away: history.statsFor(match.sport, match.away.name),
      },
      meta: { source: match.source, demo: match.source === 'demo', model: analysis.version },
    };
  }

  /** Paket analisis lengkap satu pertandingan. */
  async function analysisBundle(id) {
    return bundleOf(await get(id));
  }

  function sportCounts(matches) {
    const out = Object.fromEntries(SPORTS.map((s) => [s.id, { live: 0, upcoming: 0, finished: 0 }]));
    for (const m of matches) if (out[m.sport] && out[m.sport][m.status] !== undefined) out[m.sport][m.status]++;
    return out;
  }

  /* ------------------------------------------------------------- tugas latar */

  let backfillDay = 1;
  const BACKFILL_DAYS = 14;

  async function tick() {
    state.ticks++;
    const t = now();
    try {
      const { matches } = await fetchList({ from: t - 36 * HOUR, to: t + 48 * HOUR, sports: null });
      for (const m of matches) {
        if (m.status === 'upcoming') history.recordLivePick(m, history.analyzeMatch(m));
      }
    } catch (err) {
      log('tick gagal:', err?.message);
    }

    // Isi riwayat bertahap dari hari-hari sebelumnya (hemat batas permintaan penyedia).
    if (!primary.isDemo && backfillDay <= BACKFILL_DAYS) {
      const dayStart = t - backfillDay * 24 * HOUR;
      try {
        const rows = await primary.listMatches({ from: dayStart - 12 * HOUR, to: dayStart + 12 * HOUR, sports: null });
        history.ingestMany(rows);
        backfillDay++;
      } catch (err) {
        log('backfill gagal:', err?.message);
      }
    }

    // Tebakan yang masih menunggu hasil tetapi pertandingannya sudah lewat jadwal.
    for (const id of community.pendingMatchIds()) {
      try {
        const m = await get(id); // get() sudah menyelesaikan tebakan bila sudah selesai
        if (m.status === 'postponed' && now() - Date.parse(m.kickoff) > 7 * 24 * HOUR) {
          community.settle({ ...m, status: 'cancelled' });
        }
      } catch { /* dicoba lagi pada tick berikutnya */ }
    }
  }

  function health() {
    return {
      provider: primary.name,
      demo: !!primary.isDemo || state.fallbackActive,
      fallbackActive: state.fallbackActive,
      lastOkAt: state.lastOkAt ? new Date(state.lastOkAt).toISOString() : null,
      lastError: state.lastError,
      ticks: state.ticks,
      results: history.resultCount(),
    };
  }

  return { list, get, analysisBundle, bundleOf, sportCounts, tick, health, fetchList };
}

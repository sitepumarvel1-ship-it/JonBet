// Riwayat hasil + rating Elo yang belajar sendiri dari pertandingan yang pernah dilihat server.

import { INITIAL_ELO, analyze, eloUpdate, pickOf } from './model/model.js';
import { SPORTS_BY_ID } from './sports.js';
import { tx } from './db.js';
import { teamKey } from './util.js';

const srcOf = (m) => (m.source === 'demo' ? 'demo' : 'real');
const outcomeOf = (hs, as) => (hs > as ? 'H' : hs < as ? 'A' : 'D');

export function createHistory(db, { now: clock = () => Date.now() } = {}) {
  const q = {
    rating: db.prepare('SELECT rating, games, gf, ga FROM ratings WHERE sport = ? AND team_key = ?'),
    upsertRating: db.prepare(`
      INSERT INTO ratings (sport, team_key, name, rating, games, gf, ga) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sport, team_key) DO UPDATE SET name = excluded.name, rating = excluded.rating,
        games = excluded.games, gf = excluded.gf, ga = excluded.ga`),
    hasResult: db.prepare('SELECT 1 FROM results WHERE match_id = ?'),
    insertResult: db.prepare(`
      INSERT INTO results (match_id, sport, league, home_key, away_key, home_name, away_name, hs, as_, played_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    recent: db.prepare(`
      SELECT * FROM results WHERE sport = ? AND (home_key = ? OR away_key = ?)
      ORDER BY played_at DESC LIMIT ?`),
    h2h: db.prepare(`
      SELECT * FROM results WHERE sport = ?
        AND ((home_key = ? AND away_key = ?) OR (home_key = ? AND away_key = ?))
      ORDER BY played_at DESC LIMIT ?`),
    getPick: db.prepare('SELECT * FROM model_picks WHERE match_id = ?'),
    insertPick: db.prepare(`
      INSERT OR IGNORE INTO model_picks (match_id, sport, kind, src, pick, p_home, p_draw, p_away, min_games, made_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    settlePick: db.prepare('UPDATE model_picks SET outcome = ?, correct = ?, brier = ? WHERE match_id = ?'),
    countResults: db.prepare('SELECT COUNT(*) AS n FROM results'),
  };

  function statsFor(sport, name) {
    const r = q.rating.get(sport, teamKey(name));
    return r
      ? { rating: r.rating, games: r.games, gf: r.gf, ga: r.ga }
      : { rating: INITIAL_ELO, games: 0, gf: 0, ga: 0 };
  }

  /** Analisis pra-pertandingan memakai rating saat ini. */
  function analyzeMatch(match) {
    return analyze({
      sport: match.sport,
      match,
      homeStats: statsFor(match.sport, match.home.name),
      awayStats: statsFor(match.sport, match.away.name),
    });
  }

  /**
   * Catat hasil pertandingan selesai: uji-mundur (walk-forward) model, selesaikan tebakan model
   * yang sudah dicatat, lalu perbarui Elo. Aman dipanggil berulang (idempoten).
   */
  function ingestResult(match) {
    const cfg = SPORTS_BY_ID[match.sport];
    if (!cfg || match.status !== 'finished' || !match.score) return false;
    const hs = Number(match.score.home);
    const as = Number(match.score.away);
    if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) return false;
    if (q.hasResult.get(match.id)) return false;

    return tx(db, () => {
      const hk = teamKey(match.home.name);
      const ak = teamKey(match.away.name);
      if (!hk || !ak || hk === ak) return false;
      const playedAt = Date.parse(match.kickoff) || clock();

      // 1) Tebakan model sebelum hasil diketahui (uji-mundur bila belum pernah dicatat).
      const pre = analyzeMatch({ ...match, status: 'upcoming', score: null });
      const existing = q.getPick.get(match.id);
      if (!existing) {
        const pk = pickOf(pre.pre.probs, cfg.drawable);
        q.insertPick.run(match.id, match.sport, 'backtest', srcOf(match), pk.side,
          pre.pre.probs.home, pre.pre.probs.draw, pre.pre.probs.away, pre.confidence.games, playedAt);
      }
      const pick = existing || q.getPick.get(match.id);
      if (pick && pick.outcome == null) {
        const outcome = outcomeOf(hs, as);
        // Seri pada olahraga tanpa seri dianggap data tak valid: tidak dinilai.
        if (!(outcome === 'D' && !cfg.drawable)) {
          const o = { H: outcome === 'H' ? 1 : 0, D: outcome === 'D' ? 1 : 0, A: outcome === 'A' ? 1 : 0 };
          let brier = (pick.p_home - o.H) ** 2 + (pick.p_away - o.A) ** 2;
          if (cfg.drawable) brier += (pick.p_draw - o.D) ** 2;
          q.settlePick.run(outcome, pick.pick === outcome ? 1 : 0, brier, match.id);
        }
      }

      // 2) Simpan hasil dan perbarui rating.
      q.insertResult.run(match.id, match.sport, match.league || null, hk, ak, match.home.name, match.away.name, hs, as, playedAt);
      const h = statsFor(match.sport, match.home.name);
      const a = statsFor(match.sport, match.away.name);
      const upd = eloUpdate(match.sport, h.rating, a.rating, hs, as);
      q.upsertRating.run(match.sport, hk, match.home.name, upd.home, h.games + 1, h.gf + hs, h.ga + as);
      q.upsertRating.run(match.sport, ak, match.away.name, upd.away, a.games + 1, a.gf + as, a.ga + hs);
      return true;
    });
  }

  function ingestMany(matches) {
    const sorted = [...matches]
      .filter((m) => m.status === 'finished' && m.score)
      .sort((x, y) => Date.parse(x.kickoff) - Date.parse(y.kickoff));
    let n = 0;
    for (const m of sorted) if (ingestResult(m)) n++;
    return n;
  }

  /** Catat tebakan model untuk pertandingan yang belum mulai (sekali saja per pertandingan). */
  function recordLivePick(match, analysis) {
    if (match.status !== 'upcoming') return false;
    if (q.getPick.get(match.id)) return false;
    const cfg = SPORTS_BY_ID[match.sport];
    const pk = pickOf(analysis.pre.probs, cfg.drawable);
    const r = q.insertPick.run(match.id, match.sport, 'live', srcOf(match), pk.side,
      analysis.pre.probs.home, analysis.pre.probs.draw, analysis.pre.probs.away,
      analysis.confidence.games, clock());
    return r.changes > 0;
  }

  /** Ringkasan form 5 laga terakhir dari sudut pandang `name`. */
  function formOf(sport, name, n = 5) {
    const key = teamKey(name);
    const rows = q.recent.all(sport, key, key, n);
    const matches = rows.map((r) => {
      const home = r.home_key === key;
      const gf = home ? r.hs : r.as_;
      const ga = home ? r.as_ : r.hs;
      return {
        result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        gf, ga, home,
        opponent: home ? r.away_name : r.home_name,
        date: new Date(r.played_at).toISOString(),
        league: r.league || null,
      };
    });
    const w = matches.filter((m) => m.result === 'W').length;
    const d = matches.filter((m) => m.result === 'D').length;
    const l = matches.filter((m) => m.result === 'L').length;
    const gf = matches.reduce((s, m) => s + m.gf, 0);
    const ga = matches.reduce((s, m) => s + m.ga, 0);
    return { name, matches, w, d, l, gf, ga, n: matches.length };
  }

  function h2hOf(sport, nameA, nameB, n = 5) {
    const a = teamKey(nameA);
    const b = teamKey(nameB);
    const rows = q.h2h.all(sport, a, b, b, a, n);
    const matches = rows.map((r) => ({
      date: new Date(r.played_at).toISOString(),
      home: r.home_name, away: r.away_name, hs: r.hs, as: r.as_,
      winner: r.hs > r.as_ ? (r.home_key === a ? 'A' : 'B') : r.hs < r.as_ ? (r.away_key === a ? 'A' : 'B') : 'D',
    }));
    return {
      matches,
      aWins: matches.filter((m) => m.winner === 'A').length,
      bWins: matches.filter((m) => m.winner === 'B').length,
      draws: matches.filter((m) => m.winner === 'D').length,
    };
  }

  /** Rekam jejak model (walk-forward + tebakan langsung). */
  function modelRecord(sport = null, src = 'real') {
    const summarize = (kind, minGames) => {
      const where = ['correct IS NOT NULL', 'kind = ?', 'min_games >= ?', 'src = ?'];
      const args = [kind, minGames, src];
      if (sport) { where.push('sport = ?'); args.push(sport); }
      const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS ok, AVG(brier) AS brier
        FROM model_picks WHERE ${where.join(' AND ')}`).get(...args);
      return { n: row.n, correct: row.ok, accuracy: row.n ? row.ok / row.n : null, brier: row.brier };
    };
    const bySport = db.prepare(`
      SELECT sport, COUNT(*) AS n, SUM(correct) AS ok FROM model_picks
      WHERE correct IS NOT NULL AND min_games >= 5 AND src = ? GROUP BY sport ORDER BY n DESC`).all(src)
      .map((r) => ({ sport: r.sport, n: r.n, correct: r.ok, accuracy: r.n ? r.ok / r.n : null }));
    return { live: summarize('live', 0), backtest: summarize('backtest', 5), bySport };
  }

  const resultCount = () => q.countResults.get().n;

  return { statsFor, analyzeMatch, ingestResult, ingestMany, recordLivePick, formOf, h2hOf, modelRecord, resultCount };
}

// Komunitas: tebakan pengguna, suka, papan peringkat. Tanpa uang, tanpa taruhan: hanya poin reputasi.

import { SPORTS_BY_ID } from './sports.js';
import { HttpError } from './auth.js';
import { tx } from './db.js';

const NOTE_MAX = 280;

const cleanNote = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, NOTE_MAX);

const intOrNull = (v, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, 'Skor tebakan harus bilangan bulat 0 sampai ' + max + '.', 'bad_score');
  return n;
};

export const pointsFor = ({ won, confidence, exactScore }) => (won ? 10 + 2 * confidence + (exactScore ? 10 : 0) : -confidence);

export function createCommunity(db, { now: clock = () => Date.now() } = {}) {
  const q = {
    existing: db.prepare('SELECT id FROM predictions WHERE user_id = ? AND match_id = ?'),
    insert: db.prepare(`INSERT INTO predictions
      (user_id, match_id, sport, snapshot, pick, confidence, score_home, score_away, note, kickoff_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE predictions SET pick = ?, confidence = ?, score_home = ?, score_away = ?, note = ?, updated_at = ?
      WHERE id = ?`),
    byId: db.prepare('SELECT * FROM predictions WHERE id = ?'),
    del: db.prepare('DELETE FROM predictions WHERE id = ?'),
    like: db.prepare('INSERT OR IGNORE INTO likes (user_id, prediction_id) VALUES (?, ?)'),
    unlike: db.prepare('DELETE FROM likes WHERE user_id = ? AND prediction_id = ?'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE prediction_id = ?'),
    pending: db.prepare(`SELECT DISTINCT match_id FROM predictions WHERE status = 'pending' AND kickoff_at < ? LIMIT 200`),
    pendingForMatch: db.prepare(`SELECT * FROM predictions WHERE match_id = ? AND status = 'pending'`),
    settle: db.prepare(`UPDATE predictions SET status = ?, points = ?, settled_at = ? WHERE id = ? AND status = 'pending'`),
    userByName: db.prepare('SELECT id, username, created_at FROM users WHERE username = ?'),
    userId: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  };

  const SELECT_ROW = `
    SELECT p.*, u.username,
      (SELECT COUNT(*) FROM likes l WHERE l.prediction_id = p.id) AS likes,
      EXISTS (SELECT 1 FROM likes l WHERE l.prediction_id = p.id AND l.user_id = ?) AS liked
    FROM predictions p JOIN users u ON u.id = p.user_id`;

  function shape(r, viewerId) {
    let snap = {};
    try { snap = JSON.parse(r.snapshot); } catch { /* snapshot rusak diabaikan */ }
    return {
      id: r.id,
      user: { username: r.username },
      match: { id: r.match_id, sport: r.sport, ...snap },
      pick: r.pick,
      confidence: r.confidence,
      scoreHome: r.score_home,
      scoreAway: r.score_away,
      note: r.note,
      status: r.status,
      points: r.points,
      likes: r.likes,
      liked: !!r.liked,
      mine: viewerId != null && r.user_id === viewerId,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  function save(user, match, input) {
    const cfg = SPORTS_BY_ID[match.sport];
    if (!cfg) throw new HttpError(400, 'Cabang olahraga tidak dikenal.', 'bad_sport');
    if (match.status !== 'upcoming' || Date.parse(match.kickoff) <= clock()) {
      throw new HttpError(409, 'Tebakan sudah ditutup karena pertandingan telah dimulai.', 'closed');
    }
    const pick = String(input?.pick ?? '');
    if (!['H', 'D', 'A'].includes(pick) || (pick === 'D' && !cfg.drawable)) {
      throw new HttpError(400, 'Pilihan tebakan tidak valid untuk pertandingan ini.', 'bad_pick');
    }
    const confidence = Number(input?.confidence ?? 3);
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
      throw new HttpError(400, 'Tingkat keyakinan harus 1 sampai 5.', 'bad_confidence');
    }
    const maxScore = cfg.model === 'points' ? 400 : 99;
    let sh = intOrNull(input?.scoreHome, maxScore);
    let sa = intOrNull(input?.scoreAway, maxScore);
    if ((sh === null) !== (sa === null)) throw new HttpError(400, 'Isi kedua skor tebakan, atau kosongkan keduanya.', 'bad_score');
    if (sh !== null) {
      if (pick === 'H' && !(sh > sa)) throw new HttpError(400, 'Skor tebakan tidak sesuai dengan pilihan menang tuan rumah.', 'score_mismatch');
      if (pick === 'A' && !(sa > sh)) throw new HttpError(400, 'Skor tebakan tidak sesuai dengan pilihan menang tamu.', 'score_mismatch');
      if (pick === 'D' && sh !== sa) throw new HttpError(400, 'Skor tebakan tidak sesuai dengan pilihan seri.', 'score_mismatch');
    }
    const note = cleanNote(input?.note);
    const now = clock();
    const snapshot = JSON.stringify({
      home: match.home.name, away: match.away.name, league: match.league, kickoff: match.kickoff,
    });

    return tx(db, () => {
      const ex = q.existing.get(user.id, match.id);
      if (ex) {
        q.update.run(pick, confidence, sh, sa, note, now, ex.id);
        return { id: ex.id, updated: true };
      }
      const r = q.insert.run(user.id, match.id, match.sport, snapshot, pick, confidence, sh, sa, note, Date.parse(match.kickoff), now, now);
      return { id: Number(r.lastInsertRowid), updated: false };
    });
  }

  function remove(user, id) {
    const p = q.byId.get(id);
    if (!p || p.user_id !== user.id) throw new HttpError(404, 'Tebakan tidak ditemukan.', 'not_found');
    if (p.status !== 'pending' || p.kickoff_at <= clock()) {
      throw new HttpError(409, 'Tebakan yang sudah dikunci tidak bisa dihapus.', 'locked');
    }
    q.del.run(id);
    return true;
  }

  function toggleLike(user, id) {
    const p = q.byId.get(id);
    if (!p) throw new HttpError(404, 'Tebakan tidak ditemukan.', 'not_found');
    if (p.user_id === user.id) throw new HttpError(400, 'Kamu tidak bisa menyukai tebakanmu sendiri.', 'self_like');
    const r = q.like.run(user.id, id);
    let liked = true;
    if (r.changes === 0) { q.unlike.run(user.id, id); liked = false; }
    return { liked, likes: q.likeCount.get(id).n };
  }

  function forMatch(matchId, viewerId) {
    const rows = db.prepare(`${SELECT_ROW} WHERE p.match_id = ? ORDER BY likes DESC, p.created_at DESC LIMIT 100`).all(viewerId ?? -1, matchId);
    const agg = db.prepare(`SELECT pick, COUNT(*) AS n, AVG(confidence) AS conf FROM predictions WHERE match_id = ? GROUP BY pick`).all(matchId);
    const by = { H: 0, D: 0, A: 0 };
    let confSum = 0;
    for (const a of agg) { by[a.pick] = a.n; confSum += a.conf * a.n; }
    const total = by.H + by.D + by.A;
    return {
      total,
      counts: by,
      avgConfidence: total ? confSum / total : null,
      items: rows.map((r) => shape(r, viewerId)),
    };
  }

  function feed({ sort = 'new', sport = null, limit = 30, offset = 0, viewerId = null }) {
    const where = [];
    const args = [viewerId ?? -1];
    if (sport) { where.push('p.sport = ?'); args.push(sport); }
    const order = sort === 'top' ? 'likes DESC, p.created_at DESC' : 'p.created_at DESC';
    const sql = `${SELECT_ROW} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`;
    args.push(Math.min(Math.max(limit, 1), 50), Math.max(offset, 0));
    return db.prepare(sql).all(...args).map((r) => shape(r, viewerId));
  }

  function leaderboard({ period = 'all', limit = 20 } = {}) {
    const since = period === 'week' ? clock() - 7 * 86400_000 : 0;
    const rows = db.prepare(`
      SELECT u.username,
             SUM(p.points) AS points,
             COUNT(*) AS settled,
             SUM(CASE WHEN p.status = 'won' THEN 1 ELSE 0 END) AS wins
      FROM predictions p JOIN users u ON u.id = p.user_id
      WHERE p.status IN ('won','lost') AND p.settled_at >= ?
      GROUP BY u.id
      ORDER BY points DESC, wins DESC, settled DESC, u.username ASC
      LIMIT ?`).all(since, Math.min(Math.max(limit, 1), 100));
    return rows.map((r, i) => ({
      rank: i + 1, username: r.username, points: r.points, settled: r.settled, wins: r.wins,
      accuracy: r.settled ? r.wins / r.settled : null,
    }));
  }

  function profile(username, viewerId) {
    const u = q.userByName.get(username);
    if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan.', 'not_found');
    const stats = db.prepare(`
      SELECT COALESCE(SUM(points),0) AS points,
             COUNT(*) AS settled,
             COALESCE(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END),0) AS wins
      FROM predictions WHERE user_id = ? AND status IN ('won','lost')`).get(u.id);
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM predictions WHERE user_id = ? AND status = 'pending'`).get(u.id).n;
    const recent = db.prepare(`${SELECT_ROW} WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 30`).all(viewerId ?? -1, u.id)
      .map((r) => shape(r, viewerId));

    // Rangkaian menang berturut-turut saat ini
    const seq = db.prepare(`SELECT status FROM predictions WHERE user_id = ? AND status IN ('won','lost') ORDER BY settled_at DESC, id DESC LIMIT 50`).all(u.id);
    let streak = 0;
    for (const s of seq) { if (s.status === 'won') streak++; else break; }

    return {
      username: u.username,
      joinedAt: new Date(u.created_at).toISOString(),
      points: stats.points, settled: stats.settled, wins: stats.wins, pending, streak,
      accuracy: stats.settled ? stats.wins / stats.settled : null,
      recent,
    };
  }

  /** Nilai semua tebakan pending untuk pertandingan yang sudah selesai/dibatalkan. */
  function settle(match) {
    if (match.status !== 'finished' && match.status !== 'cancelled') return 0;
    const rows = q.pendingForMatch.all(match.id);
    if (!rows.length) return 0;
    let n = 0;
    const now = clock();
    tx(db, () => {
      for (const p of rows) {
        if (match.status === 'cancelled' || !match.score) { q.settle.run('void', 0, now, p.id); n++; continue; }
        const hs = Number(match.score.home);
        const as = Number(match.score.away);
        const outcome = hs > as ? 'H' : hs < as ? 'A' : 'D';
        const won = p.pick === outcome;
        const exact = p.score_home !== null && p.score_home === hs && p.score_away === as;
        q.settle.run(won ? 'won' : 'lost', pointsFor({ won, confidence: p.confidence, exactScore: won && exact }), now, p.id);
        n++;
      }
    });
    return n;
  }

  const pendingMatchIds = () => q.pending.all(clock()).map((r) => r.match_id);

  return { save, remove, toggleLike, forMatch, feed, leaderboard, profile, settle, pendingMatchIds };
}

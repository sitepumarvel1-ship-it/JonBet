// Komunitas lokal untuk mode statis (GitHub Pages): tanpa server, tanpa kata sandi.
// Tebakan, profil, dan peringkat hanya tersimpan di browser perangkat ini (localStorage).
// Aturan validasi dan poin sama dengan server/community.js.

const KEY = 'jonbet.local.v1';
const NOTE_MAX = 280;
const DAY = 86_400_000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'administrator', 'jonbet', 'root', 'system', 'moderator', 'support', 'ai']);

export class LocalError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const pointsFor = ({ won, confidence, exactScore }) => (won ? 10 + 2 * confidence + (exactScore ? 10 : 0) : -confidence);

const cleanNote = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, NOTE_MAX);

const intOrNull = (v, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new LocalError(400, `Skor tebakan harus bilangan bulat 0 sampai ${max}.`, 'bad_score');
  return n;
};

const emptyDb = () => ({ v: 1, nextId: 1, session: null, users: {}, predictions: [], likes: {} });

/** Penyimpanan dengan cadangan memori bila localStorage tidak bisa dipakai (mode pribadi, kuota penuh). */
export function createStore(storage) {
  let mem = null;
  return {
    load() {
      if (mem) return mem;
      let db = null;
      try {
        const raw = storage?.getItem(KEY);
        if (raw) db = JSON.parse(raw);
      } catch { db = null; }
      const ok = db && db.v === 1 && db.users && typeof db.users === 'object' && Array.isArray(db.predictions) && db.likes && typeof db.likes === 'object';
      mem = ok ? db : emptyDb();
      return mem;
    },
    save() {
      try { storage?.setItem(KEY, JSON.stringify(mem)); } catch { /* tetap hidup di memori sesi ini */ }
    },
  };
}

export function createLocalCommunity({ storage, now = () => Date.now(), sportOf }) {
  const store = createStore(storage);
  const db = () => store.load();
  const lower = (s) => String(s).toLowerCase();

  const userId = (name) => Object.keys(db().users).indexOf(lower(name)) + 1;
  const sessionUser = () => {
    const d = db();
    const u = d.session ? d.users[d.session] : null;
    return u ? { id: userId(u.username), username: u.username } : null;
  };
  const requireUser = () => {
    const u = sessionUser();
    if (!u) throw new LocalError(401, 'Masuk dulu untuk melakukan ini.', 'auth_required');
    return u;
  };

  /* ---- profil ---- */
  function validateName(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new LocalError(400, 'Nama pengguna harus 3 sampai 20 karakter: huruf, angka, atau garis bawah.', 'bad_username');
    }
    if (RESERVED.has(lower(username))) throw new LocalError(400, 'Nama pengguna ini tidak tersedia.', 'reserved_username');
  }

  function register(username) {
    validateName(username);
    const d = db();
    if (d.users[lower(username)]) throw new LocalError(409, 'Nama ini sudah dipakai di perangkat ini. Pilih nama lain atau masuk.', 'taken');
    d.users[lower(username)] = { username, createdAt: now() };
    d.session = lower(username);
    store.save();
    return { user: sessionUser() };
  }

  function login(username) {
    validateName(username);
    const d = db();
    if (!d.users[lower(username)]) throw new LocalError(401, 'Profil ini belum ada di perangkat ini. Pilih "Belum punya profil?" untuk membuatnya.', 'no_profile');
    d.session = lower(username);
    store.save();
    return { user: sessionUser() };
  }

  function logout() {
    db().session = null;
    store.save();
    return { ok: true };
  }

  /* ---- tebakan ---- */
  function shape(p, viewerKey) {
    const d = db();
    const likedBy = d.likes[p.id] || [];
    return {
      id: p.id,
      user: { username: d.users[p.user]?.username || p.user },
      match: { id: p.matchId, sport: p.sport, ...p.snapshot },
      pick: p.pick,
      confidence: p.confidence,
      scoreHome: p.scoreHome,
      scoreAway: p.scoreAway,
      note: p.note,
      status: p.status,
      points: p.points,
      likes: likedBy.length,
      liked: viewerKey ? likedBy.includes(viewerKey) : false,
      mine: viewerKey ? p.user === viewerKey : false,
      createdAt: new Date(p.createdAt).toISOString(),
    };
  }
  const viewerKey = () => db().session;

  function save(match, input) {
    const user = requireUser();
    const cfg = sportOf(match.sport);
    if (!cfg) throw new LocalError(400, 'Cabang olahraga tidak dikenal.', 'bad_sport');
    if (match.status !== 'upcoming' || Date.parse(match.kickoff) <= now()) {
      throw new LocalError(409, 'Tebakan sudah ditutup karena pertandingan telah dimulai.', 'closed');
    }
    const pick = String(input?.pick ?? '');
    if (!['H', 'D', 'A'].includes(pick) || (pick === 'D' && !cfg.drawable)) {
      throw new LocalError(400, 'Pilihan tebakan tidak valid untuk pertandingan ini.', 'bad_pick');
    }
    const confidence = Number(input?.confidence ?? 3);
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
      throw new LocalError(400, 'Tingkat keyakinan harus 1 sampai 5.', 'bad_confidence');
    }
    const maxScore = cfg.model === 'points' ? 400 : 99;
    const sh = intOrNull(input?.scoreHome, maxScore);
    const sa = intOrNull(input?.scoreAway, maxScore);
    if ((sh === null) !== (sa === null)) throw new LocalError(400, 'Isi kedua skor tebakan, atau kosongkan keduanya.', 'bad_score');
    if (sh !== null) {
      if (pick === 'H' && !(sh > sa)) throw new LocalError(400, 'Skor tebakan tidak sesuai dengan pilihan menang tuan rumah.', 'score_mismatch');
      if (pick === 'A' && !(sa > sh)) throw new LocalError(400, 'Skor tebakan tidak sesuai dengan pilihan menang tamu.', 'score_mismatch');
      if (pick === 'D' && sh !== sa) throw new LocalError(400, 'Skor tebakan tidak sesuai dengan pilihan seri.', 'score_mismatch');
    }
    const note = cleanNote(input?.note);
    const t = now();
    const d = db();
    const key = lower(user.username);
    const ex = d.predictions.find((p) => p.user === key && p.matchId === match.id);
    if (ex) {
      Object.assign(ex, { pick, confidence, scoreHome: sh, scoreAway: sa, note, updatedAt: t });
      store.save();
      return { id: ex.id, updated: true };
    }
    const p = {
      id: d.nextId++, user: key, matchId: match.id, sport: match.sport,
      snapshot: { home: match.home.name, away: match.away.name, league: match.league, kickoff: match.kickoff },
      pick, confidence, scoreHome: sh, scoreAway: sa, note,
      kickoffAt: Date.parse(match.kickoff), createdAt: t, updatedAt: t,
      status: 'pending', points: 0, settledAt: null,
    };
    d.predictions.push(p);
    store.save();
    return { id: p.id, updated: false };
  }

  function remove(id) {
    const user = requireUser();
    const d = db();
    const i = d.predictions.findIndex((p) => p.id === id);
    const p = d.predictions[i];
    if (!p || p.user !== lower(user.username)) throw new LocalError(404, 'Tebakan tidak ditemukan.', 'not_found');
    if (p.status !== 'pending' || p.kickoffAt <= now()) throw new LocalError(409, 'Tebakan yang sudah dikunci tidak bisa dihapus.', 'locked');
    d.predictions.splice(i, 1);
    delete d.likes[id];
    store.save();
    return true;
  }

  function toggleLike(id) {
    const user = requireUser();
    const d = db();
    const p = d.predictions.find((x) => x.id === id);
    if (!p) throw new LocalError(404, 'Tebakan tidak ditemukan.', 'not_found');
    const key = lower(user.username);
    if (p.user === key) throw new LocalError(400, 'Kamu tidak bisa menyukai tebakanmu sendiri.', 'self_like');
    const arr = d.likes[id] || (d.likes[id] = []);
    const i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1); else arr.push(key);
    store.save();
    return { liked: i < 0, likes: arr.length };
  }

  const byTop = (a, b) => b.likes - a.likes || Date.parse(b.createdAt) - Date.parse(a.createdAt);

  function forMatch(matchId) {
    const vk = viewerKey();
    const rows = db().predictions.filter((p) => p.matchId === matchId).map((p) => shape(p, vk));
    rows.sort(byTop);
    const by = { H: 0, D: 0, A: 0 };
    let confSum = 0;
    for (const r of rows) { by[r.pick]++; confSum += r.confidence; }
    const total = rows.length;
    return { total, counts: by, avgConfidence: total ? confSum / total : null, items: rows.slice(0, 100) };
  }

  function feed({ sort = 'new', sport = null, limit = 30, offset = 0 } = {}) {
    const vk = viewerKey();
    let rows = db().predictions.filter((p) => !sport || p.sport === sport).map((p) => shape(p, vk));
    rows.sort(sort === 'top' ? byTop : (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
    rows = rows.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.min(Math.max(limit, 1), 50));
    return rows;
  }

  function statsOf(key) {
    const mine = db().predictions.filter((p) => p.user === key);
    const settled = mine.filter((p) => p.status === 'won' || p.status === 'lost');
    return {
      points: settled.reduce((s, p) => s + p.points, 0),
      settled: settled.length,
      wins: settled.filter((p) => p.status === 'won').length,
      pending: mine.filter((p) => p.status === 'pending').length,
      all: mine,
      settledList: settled,
    };
  }

  function leaderboard({ period = 'all', limit = 20 } = {}) {
    const since = period === 'week' ? now() - 7 * DAY : 0;
    const d = db();
    const rows = [];
    for (const [key, u] of Object.entries(d.users)) {
      const s = d.predictions.filter((p) => p.user === key && (p.status === 'won' || p.status === 'lost') && p.settledAt >= since);
      if (!s.length) continue;
      rows.push({ username: u.username, points: s.reduce((a, p) => a + p.points, 0), settled: s.length, wins: s.filter((p) => p.status === 'won').length });
    }
    rows.sort((a, b) => b.points - a.points || b.wins - a.wins || b.settled - a.settled || a.username.localeCompare(b.username));
    return rows.slice(0, Math.min(Math.max(limit, 1), 100)).map((r, i) => ({
      rank: i + 1, username: r.username, points: r.points, settled: r.settled, wins: r.wins,
      accuracy: r.settled ? r.wins / r.settled : null,
    }));
  }

  function profile(username) {
    const d = db();
    const key = lower(username);
    const u = d.users[key];
    if (!u) throw new LocalError(404, 'Pengguna tidak ditemukan.', 'not_found');
    const s = statsOf(key);
    const vk = viewerKey();
    const recent = [...s.all].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id).slice(0, 30).map((p) => shape(p, vk));
    const seq = [...s.settledList].sort((a, b) => b.settledAt - a.settledAt || b.id - a.id).slice(0, 50);
    let streak = 0;
    for (const p of seq) { if (p.status === 'won') streak++; else break; }
    return {
      username: u.username,
      joinedAt: new Date(u.createdAt).toISOString(),
      points: s.points, settled: s.settled, wins: s.wins, pending: s.pending, streak,
      accuracy: s.settled ? s.wins / s.settled : null,
      recent,
    };
  }

  /* ---- penilaian ---- */
  const hasPending = () => db().predictions.some((p) => p.status === 'pending');

  /**
   * Nilai tebakan yang menunggu. lookup(matchId) -> { status: 'finished', score: {home, away} }
   * | { status: 'cancelled' } | null (belum diketahui). Tebakan yang tidak kunjung ada hasilnya
   * setelah 14 hari sejak kickoff dibatalkan agar tidak menggantung selamanya.
   */
  function settle(lookup) {
    const d = db();
    const t = now();
    let n = 0;
    for (const p of d.predictions) {
      if (p.status !== 'pending') continue;
      const r = lookup(p.matchId);
      if (r?.status === 'finished' && r.score && Number.isFinite(Number(r.score.home)) && Number.isFinite(Number(r.score.away))) {
        const hs = Number(r.score.home);
        const as = Number(r.score.away);
        const outcome = hs > as ? 'H' : hs < as ? 'A' : 'D';
        const won = p.pick === outcome;
        const exact = p.scoreHome !== null && p.scoreHome === hs && p.scoreAway === as;
        p.status = won ? 'won' : 'lost';
        p.points = pointsFor({ won, confidence: p.confidence, exactScore: won && exact });
        p.settledAt = t;
        n++;
      } else if (r?.status === 'cancelled' || (!r && t - p.kickoffAt > 14 * DAY)) {
        p.status = 'void';
        p.points = 0;
        p.settledAt = t;
        n++;
      }
    }
    if (n) store.save();
    return n;
  }

  return { me: () => ({ user: sessionUser() }), register, login, logout, save, remove, toggleLike, forMatch, feed, leaderboard, profile, settle, hasPending };
}

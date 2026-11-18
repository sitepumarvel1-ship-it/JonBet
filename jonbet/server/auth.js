// Akun pengguna: kata sandi di-hash dengan scrypt, sesi memakai token acak (disimpan sebagai hash SHA-256).

import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'administrator', 'jonbet', 'root', 'system', 'moderator', 'support', 'ai']);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Nama pengguna harus 3 sampai 20 karakter: huruf, angka, atau garis bawah.', 'bad_username');
  }
  if (RESERVED.has(username.toLowerCase())) throw new HttpError(400, 'Nama pengguna ini tidak tersedia.', 'reserved_username');
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    throw new HttpError(400, 'Kata sandi harus 8 sampai 72 karakter.', 'bad_password');
  }
}

export function createAuth(db) {
  const q = {
    insertUser: db.prepare('INSERT INTO users (username, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare(`SELECT u.id, u.username, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token_hash = ? AND s.expires_at > ?`),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  // Penguncian sementara setelah gagal login berulang (per nama pengguna).
  const failures = new Map(); // lower(username) -> {n, until}
  const MAX_FAILS = 5;
  const LOCK_MS = 60_000;

  function checkLock(name) {
    const f = failures.get(name.toLowerCase());
    if (f && f.until > Date.now()) {
      throw new HttpError(429, 'Terlalu banyak percobaan masuk. Coba lagi sekitar satu menit.', 'locked');
    }
  }
  function noteFail(name) {
    const key = name.toLowerCase();
    const f = failures.get(key) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    failures.set(key, f);
    if (failures.size > 5000) failures.clear();
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = Date.now() + config.sessionDays * 86400_000;
    q.insertSession.run(sha256(token), userId, expires);
    return { token, expires };
  }

  function register(username, password) {
    validateCredentials(username, password);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    try {
      const r = q.insertUser.run(username, salt, hash, Date.now());
      const id = Number(r.lastInsertRowid);
      return { user: { id, username }, session: createSession(id) };
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, 'Nama pengguna sudah dipakai.', 'username_taken');
      throw err;
    }
  }

  function login(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username || username.length > 40 || password.length > 200) {
      throw new HttpError(400, 'Isi nama pengguna dan kata sandi.', 'bad_request');
    }
    checkLock(username);
    const u = q.byName.get(username);
    // Selalu hitung hash agar waktu respons tidak membocorkan keberadaan akun.
    const salt = u ? u.pass_salt : '00'.repeat(16);
    const hash = Buffer.from(hashPassword(password, salt), 'hex');
    const ok = u && crypto.timingSafeEqual(hash, Buffer.from(u.pass_hash, 'hex'));
    if (!ok) {
      noteFail(username);
      throw new HttpError(401, 'Nama pengguna atau kata sandi salah.', 'bad_credentials');
    }
    failures.delete(username.toLowerCase());
    return { user: { id: u.id, username: u.username }, session: createSession(u.id) };
  }

  function userFromToken(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const row = q.session.get(sha256(token), Date.now());
    return row ? { id: row.id, username: row.username, createdAt: row.created_at } : null;
  }

  function logout(token) {
    if (token) q.delSession.run(sha256(token));
  }

  const purgeExpired = () => q.purge.run(Date.now());

  return { register, login, logout, userFromToken, purgeExpired };
}

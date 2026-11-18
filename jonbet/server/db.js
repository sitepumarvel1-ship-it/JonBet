import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS ratings (
  sport TEXT NOT NULL,
  team_key TEXT NOT NULL,
  name TEXT NOT NULL,
  rating REAL NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  gf REAL NOT NULL DEFAULT 0,
  ga REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (sport, team_key)
);

CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  league TEXT,
  home_key TEXT NOT NULL,
  away_key TEXT NOT NULL,
  home_name TEXT NOT NULL,
  away_name TEXT NOT NULL,
  hs INTEGER NOT NULL,
  as_ INTEGER NOT NULL,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_home ON results(sport, home_key, played_at);
CREATE INDEX IF NOT EXISTS idx_results_away ON results(sport, away_key, played_at);

CREATE TABLE IF NOT EXISTS model_picks (
  match_id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('live','backtest')),
  src TEXT NOT NULL DEFAULT 'real',
  pick TEXT NOT NULL,
  p_home REAL NOT NULL,
  p_draw REAL NOT NULL,
  p_away REAL NOT NULL,
  min_games INTEGER NOT NULL DEFAULT 0,
  made_at INTEGER NOT NULL,
  outcome TEXT,
  correct INTEGER,
  brier REAL
);
CREATE INDEX IF NOT EXISTS idx_model_picks_sport ON model_picks(sport, kind);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  pick TEXT NOT NULL CHECK (pick IN ('H','D','A')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  score_home INTEGER,
  score_away INTEGER,
  note TEXT NOT NULL DEFAULT '',
  kickoff_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void')),
  points INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER,
  UNIQUE (user_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_pred_match ON predictions(match_id);
CREATE INDEX IF NOT EXISTS idx_pred_user ON predictions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pred_created ON predictions(created_at);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, prediction_id)
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

/** Jalankan fn dalam transaksi; rollback bila melempar galat. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* sudah di-rollback */ }
    throw err;
  }
}

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'jarvis.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, id);
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fact TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
`);

const q = (sql) => db.prepare(sql);

export const users = {
  count: () => q('SELECT COUNT(*) AS n FROM users').get().n,
  byName: (name) => q('SELECT * FROM users WHERE username = ?').get(name),
  byId: (id) => q('SELECT * FROM users WHERE id = ?').get(id),
  create: (username, passHash, isAdmin) =>
    Number(q('INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?,?,?,?)').run(username, passHash, isAdmin ? 1 : 0, Date.now()).lastInsertRowid),
};

export const devices = {
  create: (id, userId, name, tokenHash) =>
    q('INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?,?,?,?,?)').run(id, userId, name, tokenHash, Date.now()),
  byTokenHash: (h) => q('SELECT * FROM devices WHERE token_hash = ?').get(h),
  list: (userId) => q('SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY created_at').all(userId),
  remove: (userId, id) => q('DELETE FROM devices WHERE user_id = ? AND id = ?').run(userId, id).changes,
  touch: (id) => q('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id),
};

export const messages = {
  add: (userId, role, content) => q('INSERT INTO messages (user_id, role, content, ts) VALUES (?,?,?,?)').run(userId, role, content, Date.now()),
  recent: (userId, n = 20) =>
    q('SELECT role, content, ts FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, n).reverse(),
  clear: (userId) => q('DELETE FROM messages WHERE user_id = ?').run(userId),
};

export const memories = {
  list: (userId) => q('SELECT id, fact FROM memories WHERE user_id = ? ORDER BY id').all(userId),
  add: (userId, fact) => Number(q('INSERT INTO memories (user_id, fact, ts) VALUES (?,?,?)').run(userId, fact, Date.now()).lastInsertRowid),
  remove: (userId, id) => q('DELETE FROM memories WHERE user_id = ? AND id = ?').run(userId, id).changes,
};

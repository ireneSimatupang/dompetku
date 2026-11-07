'use strict';
// SQLite storage via node:sqlite (built into Node 22.5+; no flag needed from 22.13 / 23.4).
const fs = require('fs');
const path = require('path');

let DatabaseSync;
{
  // Hide only the one-time "SQLite is an experimental feature" warning.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch {
    console.error('node:sqlite tidak tersedia. Gunakan Node.js 22.13+ (atau 22.5+ dengan flag --experimental-sqlite).');
    process.exit(1);
  } finally { process.emitWarning = emit; }
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  active INTEGER NOT NULL DEFAULT 1,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bank',
  initial_balance INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_name ON accounts(user_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('pemasukan','pengeluaran','transfer')),
  name TEXT NOT NULL,
  limit_amount INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_name ON categories(user_id, type, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS savings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  initial_balance INTEGER NOT NULL DEFAULT 0,
  target INTEGER NOT NULL DEFAULT 0,
  target_date TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

-- Amounts are whole rupiah (INTEGER) so sums are exact.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('pemasukan','pengeluaran','transfer','tabungan')),
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '00:00',
  amount INTEGER NOT NULL CHECK (amount > 0),
  detail TEXT NOT NULL DEFAULT '',
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER REFERENCES accounts(id),
  category_id INTEGER REFERENCES categories(id),
  saving_id INTEGER REFERENCES savings(id),
  direction TEXT CHECK (direction IN ('setor','tarik')),
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date, time);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_to_account ON transactions(to_account_id) WHERE to_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_saving ON transactions(saving_id) WHERE saving_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_source ON transactions(user_id, source) WHERE source IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, key)
);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  value TEXT NOT NULL
);
`;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!v) db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  // Future schema changes go here: if (Number(v.value) < 2) { db.exec('ALTER TABLE ...'); ... }
  return db;
}

// Run fn inside one transaction; rolls back on error.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : null;
}
function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

// One-time import of the old JSON store (data/db.json). Keeps every id so all links stay intact.
function importJson(db, jsonFile) {
  if (!fs.existsSync(jsonFile)) return null;
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  const d = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const int = v => Math.round(Number(v) || 0);
  const on = v => (v === false ? 0 : 1);
  const now = new Date().toISOString();
  tx(db, () => {
    const ins = (sql, rows, map) => { const st = db.prepare(sql); for (const r of rows || []) st.run(...map(r)); };
    ins('INSERT INTO users (id, username, name, role, active, salt, hash, created_at) VALUES (?,?,?,?,?,?,?,?)', d.users,
      u => [u.id, u.username, u.name || u.username, u.role === 'admin' ? 'admin' : 'user', on(u.active), u.salt, u.hash, u.createdAt || now]);
    ins('INSERT INTO accounts (id, user_id, name, type, initial_balance, active) VALUES (?,?,?,?,?,?)', d.accounts,
      a => [a.id, a.userId, a.name, a.type || 'bank', int(a.initialBalance), on(a.active)]);
    ins('INSERT INTO categories (id, user_id, type, name, limit_amount, active) VALUES (?,?,?,?,?,?)', d.categories,
      c => [c.id, c.userId, c.type, c.name, int(c.limit), on(c.active)]);
    ins('INSERT INTO savings (id, user_id, name, place, initial_balance, target, target_date, active) VALUES (?,?,?,?,?,?,?,?)', d.savings,
      s => [s.id, s.userId, s.name, s.place || '', int(s.initialBalance), int(s.target), s.targetDate || '', on(s.active)]);
    ins(`INSERT INTO transactions (id, user_id, type, date, time, amount, detail, account_id, to_account_id, category_id, saving_id, direction, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, d.transactions,
      t => [t.id, t.userId, t.type, t.date, t.time || '00:00', Math.max(1, int(t.amount)), t.detail || '', t.accountId, t.toAccountId || null,
        t.categoryId || null, t.savingId || null, t.direction || null, t.source || null, t.createdAt || now]);
    ins('INSERT OR IGNORE INTO notifications (id, user_id, key, level, title, body, read, created_at) VALUES (?,?,?,?,?,?,?,?)', d.notifications,
      n => [n.id, n.userId, n.key, n.level, n.title, n.body, n.read ? 1 : 0, n.createdAt || now]);
    ins('INSERT OR IGNORE INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)', d.pushSubs,
      p => [p.userId, p.subscription.endpoint, p.subscription.keys.p256dh, p.subscription.keys.auth, p.createdAt || now]);
    ins('INSERT INTO settings (user_id, value) VALUES (?,?)', d.settings, s => [s.userId, JSON.stringify(s.values || {})]);
    if (d.meta && d.meta.vapid) setMeta(db, 'vapid', d.meta.vapid);
  });
  fs.renameSync(jsonFile, jsonFile + '.migrated');
  return { users: (d.users || []).length, transactions: (d.transactions || []).length };
}

module.exports = { open, tx, getMeta, setMeta, importJson };

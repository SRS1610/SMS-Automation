import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,
  config_enc        TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 10,
  countries         TEXT NOT NULL DEFAULT '[]',
  rate_limit        REAL NOT NULL DEFAULT 10,
  default_sender    TEXT,
  webhook_token     TEXT NOT NULL,
  last_test_at      TEXT,
  last_test_ok      INTEGER,
  last_test_message TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  body          TEXT NOT NULL,
  sender        TEXT,
  provider_id   TEXT,
  status        TEXT NOT NULL,
  scheduled_at  TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  total         INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_created ON campaigns(created_at);

CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  to_number           TEXT NOT NULL,
  country             TEXT,
  body                TEXT NOT NULL,
  encoding            TEXT NOT NULL,
  segments            INTEGER NOT NULL,
  status              TEXT NOT NULL,
  provider_id         TEXT,
  provider_message_id TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  sent_at             TEXT,
  delivered_at        TEXT,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_queue ON messages(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_provider_msg ON messages(provider_id, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppressions (
  number     TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL
);
`;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();

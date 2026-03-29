import Database from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'ocom.db');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database.Database(dbPath);

const sql = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  project_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  token_enc TEXT,
  refresh_enc TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  mode TEXT NOT NULL DEFAULT 'primary',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, account_id),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS metrics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  agent_id INTEGER,
  event_type TEXT NOT NULL,
  latency_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assignments_agent_priority ON assignments(agent_id, priority);
CREATE INDEX IF NOT EXISTS idx_metrics_events_created_at ON metrics_events(created_at);
`;

db.exec(sql, (err) => {
  if (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
  console.log('Migration OK:', dbPath);
  db.close();
});

import sqlite3 from 'sqlite3';
import path from 'path';
import { config } from 'dotenv';

config();

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'ocom.db');

function migrate() {
  // Asegurar que el directorio data existe
  const dir = path.dirname(dbPath);
  if (!require('fs').existsSync(dir)) {
    require('fs').mkdirSync(dir, { recursive: true });
  }

  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening database:', err);
      process.exit(1);
    } else {
      console.log('Connected to database:', dbPath);
    }
  });

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT,
        workspace TEXT,
        default_model TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        access_token_enc BLOB,
        refresh_token_enc BLOB,
        expires_at TEXT,
        health_score REAL DEFAULT 100,
        locked INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(provider, account_id, profile_id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_slug TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        priority INTEGER DEFAULT 100,
        mode TEXT DEFAULT 'primary',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (agent_slug) REFERENCES agents(slug),
        FOREIGN KEY (account_id) REFERENCES accounts(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload TEXT,
        hmac TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END
    `);

    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS metrics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent_slug TEXT,
        account_id INTEGER,
        value REAL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    console.log('Migration completed');
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      }
    });
  });
}

migrate();

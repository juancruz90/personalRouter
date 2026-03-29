import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssignmentsService } from '../src/assignmentsService';
import { RouterService } from '../src/routerService';

function initializeSchema(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
      }
    });

    db.serialize(() => {
      db.run(
        `
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          expires_at TEXT,
          health_score REAL DEFAULT 100,
          locked INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `,
      );

      db.run(
        `
        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_slug TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          priority INTEGER DEFAULT 100,
          mode TEXT DEFAULT 'primary',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `,
      );

      db.run(
        `
        INSERT INTO accounts (provider, account_id, profile_id, health_score, locked, created_at, updated_at)
        VALUES
          ('openai-codex', 'acct-pri', 'openai-codex:pri', 95, 0, datetime('now'), datetime('now')),
          ('openai-codex', 'acct-fallback', 'openai-codex:fallback', 40, 0, datetime('now'), datetime('now'))
      `,
        (runErr) => {
          db.close((closeErr) => {
            if (runErr) {
              reject(runErr);
              return;
            }

            if (closeErr) {
              reject(closeErr);
              return;
            }

            resolve();
          });
        },
      );
    });
  });
}

function setLocked(dbPath: string, id: number, locked: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.run(
      `UPDATE accounts SET locked = ?, updated_at = datetime('now') WHERE id = ?`,
      [locked, id],
      (err) => {
        db.close(() => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      },
    );
  });
}

describe('RouterService', () => {
  let tempDir: string;
  let dbPath: string;
  let assignments: AssignmentsService;
  let router: RouterService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-router-'));
    dbPath = path.join(tempDir, 'ocom.db');

    await initializeSchema(dbPath);

    assignments = new AssignmentsService(dbPath);
    router = new RouterService(assignments);

    await assignments.upsert({ agentSlug: 'florencia', accountId: 1, priority: 1, mode: 'primary' });
    await assignments.upsert({ agentSlug: 'florencia', accountId: 2, priority: 2, mode: 'fallback' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('selects highest priority eligible account', async () => {
    const selected = await router.select('florencia', 'openai-codex');

    expect(selected.ok).toBe(true);
    expect(selected.selected?.accountId).toBe(1);
    expect(selected.failoverApplied).toBe(false);
  });

  it('fails over when primary account becomes revoked', async () => {
    await setLocked(dbPath, 1, 1);

    const selected = await router.select('florencia', 'openai-codex');

    expect(selected.ok).toBe(true);
    expect(selected.selected?.accountId).toBe(2);
    expect(selected.failoverApplied).toBe(true);
    expect(selected.selected?.status).toBe('degraded');
  });
});

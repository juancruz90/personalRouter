import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssignmentsService } from '../src/assignmentsService';

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
          access_token_enc BLOB,
          refresh_token_enc BLOB,
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
          ('openai-codex', 'acct-a', 'openai-codex:a', 95, 0, datetime('now'), datetime('now')),
          ('openai-codex', 'acct-b', 'openai-codex:b', 40, 0, datetime('now'), datetime('now'))
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

describe('AssignmentsService', () => {
  let tempDir: string;
  let dbPath: string;
  let service: AssignmentsService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-assignments-'));
    dbPath = path.join(tempDir, 'ocom.db');

    await initializeSchema(dbPath);
    service = new AssignmentsService(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts assignment and updates existing pair', async () => {
    const created = await service.upsert({
      agentSlug: 'florencia',
      accountId: 1,
      priority: 10,
      mode: 'primary',
    });

    expect(created.agentSlug).toBe('florencia');
    expect(created.account.provider).toBe('openai-codex');
    expect(created.priority).toBe(10);

    const updated = await service.upsert({
      agentSlug: 'florencia',
      accountId: 1,
      priority: 5,
      mode: 'fallback',
    });

    expect(updated.id).toBe(created.id);
    expect(updated.priority).toBe(5);
    expect(updated.mode).toBe('fallback');

    const list = await service.list({ agentSlug: 'florencia' });
    expect(list).toHaveLength(1);
  });

  it('lists assignments filtered by provider and removes by id', async () => {
    const a = await service.upsert({ agentSlug: 'florencia', accountId: 1, priority: 1 });
    await service.upsert({ agentSlug: 'florencia', accountId: 2, priority: 2 });

    const items = await service.list({ provider: 'openai-codex' });
    expect(items).toHaveLength(2);

    const removed = await service.removeById(a.id);
    expect(removed).toBe(true);

    const after = await service.list({ provider: 'openai-codex' });
    expect(after).toHaveLength(1);
  });
});

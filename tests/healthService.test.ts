import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accountsService';
import { TokenVault } from '../src/tokenVault';
import { HealthService, computeHealthScore } from '../src/healthService';

function initializeAccountsTable(dbPath: string): Promise<void> {
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
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(provider, account_id, profile_id)
        )
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

describe('HealthService', () => {
  let tempDir: string;
  let dbPath: string;
  let accounts: AccountsService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-health-'));
    dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);
    accounts = new AccountsService(dbPath, new TokenVault('health-test-master-key'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('computes health score from token expiry windows', () => {
    const now = Date.now();
    const in2m = new Date(now + 2 * 60_000).toISOString();
    const in2h = new Date(now + 2 * 60 * 60_000).toISOString();
    const in2d = new Date(now + 2 * 24 * 60 * 60_000).toISOString();

    expect(computeHealthScore({ locked: false, expiresAt: in2m }, now).score).toBe(10);
    expect(computeHealthScore({ locked: false, expiresAt: in2h }, now).score).toBe(60);
    expect(computeHealthScore({ locked: false, expiresAt: in2d }, now).score).toBe(100);
    expect(computeHealthScore({ locked: true, expiresAt: in2d }, now).score).toBe(0);
  });

  it('runs health scoring and updates account scores', async () => {
    await accounts.create({
      provider: 'openai-codex',
      accountId: 'acct-health-1',
      profileId: 'openai-codex:health-1',
      healthScore: 99,
      expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    });

    await accounts.create({
      provider: 'openai-codex',
      accountId: 'acct-health-2',
      profileId: 'openai-codex:health-2',
      healthScore: 99,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
    });

    const service = new HealthService(accounts);
    const run = await service.runOnce({ provider: 'openai-codex' });

    expect(run.scanned).toBe(2);
    expect(run.updated).toBe(2);
    expect(run.failover).toBeGreaterThanOrEqual(1);

    const all = await accounts.list({ provider: 'openai-codex' });
    const nearExpiry = all.find((item) => item.profileId === 'openai-codex:health-1');
    expect(nearExpiry?.healthScore).toBe(10);
  });
});

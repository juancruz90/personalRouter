import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
  'HEALTH_CHECK_INTERVAL_MINUTES',
] as const;

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
      );

      db.run(
        `
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

describe('server health routes', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-health-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-health-master-key';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
  });

  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }

    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs health scoring manually via API', async () => {
    const server = createServer();
    servers.push(server);

    const create = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-health-api',
        profileId: 'openai-codex:health-api',
        expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        healthScore: 99,
      },
    });

    expect(create.statusCode).toBe(201);

    const run = await server.inject({
      method: 'POST',
      url: '/health/run',
      payload: {
        provider: 'openai-codex',
      },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      ok: true,
      scanned: 1,
      updated: 1,
      failover: 1,
    });
  });
});

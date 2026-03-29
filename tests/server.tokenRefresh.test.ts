import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
  'OAUTH_OPENAI_CODEX_CLIENT_ID',
  'OAUTH_OPENAI_CODEX_AUTH_URL',
  'OAUTH_OPENAI_CODEX_REDIRECT_URI',
  'OAUTH_OPENAI_CODEX_TOKEN_URL',
  'TOKEN_REFRESH_INTERVAL_MS',
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

describe('server token refresh route', () => {
  let tempDir: string;
  let dbPath: string;
  const servers: Array<ReturnType<typeof createServer>> = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-refresh-'));
    dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-refresh-master-key';
    process.env.OAUTH_OPENAI_CODEX_CLIENT_ID = 'cid-test';
    process.env.OAUTH_OPENAI_CODEX_AUTH_URL = 'https://auth.example.com/authorize';
    process.env.OAUTH_OPENAI_CODEX_REDIRECT_URI = 'http://127.0.0.1:3001/oauth/openai-codex/callback';
    process.env.OAUTH_OPENAI_CODEX_TOKEN_URL = 'https://auth.example.com/token';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
  });

  afterEach(async () => {
    vi.restoreAllMocks();

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

  it('runs manual token refresh and returns summary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 1800,
      }),
    } as Response);

    const server = createServer();
    servers.push(server);

    const soonExpiring = new Date(Date.now() + 2 * 60_000).toISOString();

    const createAccount = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-refresh-api',
        profileId: 'openai-codex:refresh-api',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: soonExpiring,
      },
    });

    expect(createAccount.statusCode).toBe(201);

    const refreshResponse = await server.inject({
      method: 'POST',
      url: '/tokens/refresh/run',
      payload: {
        provider: 'openai-codex',
        expiresInMinutes: 10,
      },
    });

    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({
      ok: true,
      scanned: 1,
      refreshed: 1,
      failed: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

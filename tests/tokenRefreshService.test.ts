import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../src/accountsService';
import { TokenVault } from '../src/tokenVault';
import { TokenRefreshService } from '../src/tokenRefreshService';

const ENV_KEYS = [
  'OAUTH_OPENAI_CODEX_CLIENT_ID',
  'OAUTH_OPENAI_CODEX_AUTH_URL',
  'OAUTH_OPENAI_CODEX_REDIRECT_URI',
  'OAUTH_OPENAI_CODEX_TOKEN_URL',
  'OAUTH_OPENAI_CODEX_CLIENT_SECRET',
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

describe('TokenRefreshService', () => {
  let tempDir: string;
  let dbPath: string;
  let accounts: AccountsService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-refresh-'));
    dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    accounts = new AccountsService(dbPath, new TokenVault('refresh-service-master-key'));

    process.env.OAUTH_OPENAI_CODEX_CLIENT_ID = 'cid-test';
    process.env.OAUTH_OPENAI_CODEX_AUTH_URL = 'https://auth.example.com/authorize';
    process.env.OAUTH_OPENAI_CODEX_REDIRECT_URI = 'http://127.0.0.1:3001/oauth/openai-codex/callback';
    process.env.OAUTH_OPENAI_CODEX_TOKEN_URL = 'https://auth.example.com/token';
    delete process.env.OAUTH_OPENAI_CODEX_CLIENT_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();

    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('refreshes soon-expiring tokens using provider token endpoint', async () => {
    const soonExpiring = new Date(Date.now() + 2 * 60_000).toISOString();

    const account = await accounts.create({
      provider: 'openai-codex',
      accountId: 'acct-refresh-1',
      profileId: 'openai-codex:refresh-1',
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: soonExpiring,
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    } as Response);

    const service = new TokenRefreshService(accounts, globalThis.fetch);
    const result = await service.runOnce({ provider: 'openai-codex', expiresInMinutes: 10 });

    expect(result.scanned).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);

    const candidates = await accounts.listRefreshCandidates({
      provider: 'openai-codex',
      expiresBefore: new Date(Date.now() + 200 * 60_000).toISOString(),
    });

    const refreshed = candidates.find((item) => item.id === account.id);
    expect(refreshed?.refreshToken).toBe('new-refresh-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://auth.example.com/token');
  });
});

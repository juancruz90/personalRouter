import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
  'TOKEN_REFRESH_INTERVAL_MS',
  'HEALTH_CHECK_INTERVAL_MINUTES',
  'BACKUP_INTERVAL_HOURS',
  'ACCOUNT_RUNTIME_RECOVER_INTERVAL_MINUTES',
  'OAUTH_CALLBACK_BRIDGE_ENABLED',
  'GATEWAY_API_TOKEN',
] as const;

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
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(provider, account_id, profile_id)
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

describe('server /api/auth/profiles/status', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-auth-profiles-status-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'auth-profiles-status-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
    process.env.BACKUP_INTERVAL_HOURS = '0';
    process.env.ACCOUNT_RUNTIME_RECOVER_INTERVAL_MINUTES = '0';
    process.env.OAUTH_CALLBACK_BRIDGE_ENABLED = 'false';
    process.env.GATEWAY_API_TOKEN = 'test-gateway-token';
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

  it('requires gateway API token and returns profile status payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 12,
            reset_at: 1770000000,
          },
        },
      }),
    } as Response);

    const server = createServer();
    servers.push(server);

    const created = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'user@example.com',
        profileId: 'openai-codex:user@example.com',
        accessToken: 'atk-status',
      },
    });

    expect(created.statusCode).toBe(201);

    const probe = await server.inject({
      method: 'POST',
      url: '/accounts/runtime/probe',
      payload: { provider: 'openai-codex' },
    });

    expect(probe.statusCode).toBe(200);

    const unauthorized = await server.inject({
      method: 'GET',
      url: '/api/auth/profiles/status',
    });

    expect(unauthorized.statusCode).toBe(401);

    const authorized = await server.inject({
      method: 'GET',
      url: '/api/auth/profiles/status',
      headers: {
        'x-api-key': 'test-gateway-token',
      },
    });

    expect(authorized.statusCode).toBe(200);
    const payload = authorized.json();
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]).toMatchObject({
      profile_id: 'openai-codex:user@example.com',
      email: 'user@example.com',
      provider: 'openai-codex',
      status: 'ok',
      quota_remaining_pct: 88,
      cooldown_until: null,
    });
    expect(payload[0].last_verified_at).toBeTruthy();
  });

  it('returns 503 when API token is not configured', async () => {
    delete process.env.GATEWAY_API_TOKEN;

    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/profiles/status',
      headers: {
        'x-api-key': 'any-token',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'gateway_api_token_not_configured',
    });
  });
});

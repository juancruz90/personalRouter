import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'OAUTH_OPENAI_CODEX_CLIENT_ID',
  'OAUTH_OPENAI_CODEX_AUTH_URL',
  'OAUTH_OPENAI_CODEX_REDIRECT_URI',
  'OAUTH_OPENAI_CODEX_SCOPES',
  'OAUTH_OPENAI_CODEX_TOKEN_URL',
  'OAUTH_OPENAI_CODEX_CLIENT_SECRET',
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
] as const;

const servers: Array<ReturnType<typeof createServer>> = [];

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = toBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

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

beforeEach(() => {
  process.env.OAUTH_OPENAI_CODEX_CLIENT_ID = 'cid-test';
  process.env.OAUTH_OPENAI_CODEX_AUTH_URL = 'https://auth.example.com/authorize';
  process.env.OAUTH_OPENAI_CODEX_REDIRECT_URI = 'http://127.0.0.1:3001/oauth/openai-codex/callback';
  process.env.OAUTH_OPENAI_CODEX_SCOPES = 'openid profile';
  delete process.env.OAUTH_OPENAI_CODEX_TOKEN_URL;
  delete process.env.OAUTH_OPENAI_CODEX_CLIENT_SECRET;
});

afterEach(async () => {
  vi.restoreAllMocks();

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  while (servers.length) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

describe('server oauth pkce routes', () => {
  it('serves oauth wizard UI page', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/ui/oauth-wizard',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('OAuth Account Wizard');
    expect(response.body).toContain('/oauth/');
    expect(response.body).toContain("searchParams.set('store', '1')");
  });

  it('starts oauth flow with authorization url', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/start',
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json();
    expect(payload.ok).toBe(true);
    expect(payload.provider).toBe('openai-codex');
    expect(payload.authorizationUrl).toContain('https://auth.example.com/authorize');
    expect(payload.authorizationUrl).toContain('code_challenge_method=S256');
    expect(payload.state).toBeTypeOf('string');
  });

  it('stores encrypted account tokens when callback includes store context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-oauth-store-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'oauth-store-master-key';
    process.env.OAUTH_OPENAI_CODEX_TOKEN_URL = 'https://auth.example.com/token';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'atk-123',
        refresh_token: 'rtk-456',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile',
      }),
    } as Response);

    const server = createServer();
    servers.push(server);

    const startResponse = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/start?store=1&accountId=acct-store&profileId=openai-codex%3Astore&healthScore=88',
    });

    expect(startResponse.statusCode).toBe(200);
    const { state } = startResponse.json();

    const callback = await server.inject({
      method: 'GET',
      url: `/oauth/openai-codex/callback?state=${encodeURIComponent(state)}&code=abc123`,
    });

    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({
      ok: true,
      tokenExchanged: true,
      stored: true,
      account: {
        provider: 'openai-codex',
        accountId: 'acct-store',
        profileId: 'openai-codex:store',
      },
    });

    const listResponse = await server.inject({
      method: 'GET',
      url: '/accounts?provider=openai-codex',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().accounts).toHaveLength(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('derives openai-codex profileId/accountId from JWT email when store context omits ids', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-oauth-jwt-email-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'oauth-store-master-key';
    process.env.OAUTH_OPENAI_CODEX_TOKEN_URL = 'https://auth.example.com/token';

    const jwt = buildFakeJwt({
      'https://api.openai.com/profile.email': 'User.Email+test@example.com',
      chatgpt_user_id: 'u_123',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: jwt,
        refresh_token: 'rtk-789',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile',
      }),
    } as Response);

    const server = createServer();
    servers.push(server);

    const startResponse = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/start?store=1',
    });

    expect(startResponse.statusCode).toBe(200);
    const { state } = startResponse.json();

    const callback = await server.inject({
      method: 'GET',
      url: `/oauth/openai-codex/callback?state=${encodeURIComponent(state)}&code=abc123`,
    });

    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({
      ok: true,
      tokenExchanged: true,
      stored: true,
      account: {
        provider: 'openai-codex',
        accountId: 'user.email+test@example.com',
        profileId: 'openai-codex:user.email+test@example.com',
      },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses default, default-2 profile ids for openai-codex when JWT email is unavailable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-oauth-default-profile-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'oauth-store-master-key';
    process.env.OAUTH_OPENAI_CODEX_TOKEN_URL = 'https://auth.example.com/token';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'opaque-token-without-jwt-email',
        refresh_token: 'rtk-default',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile',
      }),
    } as Response);

    const server = createServer();
    servers.push(server);

    const start1 = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/start?store=1&accountId=acct-default-1',
    });
    const state1 = start1.json().state as string;

    const callback1 = await server.inject({
      method: 'GET',
      url: `/oauth/openai-codex/callback?state=${encodeURIComponent(state1)}&code=abc-1`,
    });

    expect(callback1.statusCode).toBe(200);
    expect(callback1.json()).toMatchObject({
      ok: true,
      stored: true,
      account: {
        accountId: 'acct-default-1',
        profileId: 'openai-codex:default',
      },
    });

    const start2 = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/start?store=1&accountId=acct-default-2',
    });
    const state2 = start2.json().state as string;

    const callback2 = await server.inject({
      method: 'GET',
      url: `/oauth/openai-codex/callback?state=${encodeURIComponent(state2)}&code=abc-2`,
    });

    expect(callback2.statusCode).toBe(200);
    expect(callback2.json()).toMatchObject({
      ok: true,
      stored: true,
      account: {
        accountId: 'acct-default-2',
        profileId: 'openai-codex:default-2',
      },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns provider error from callback when oauth provider rejects', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/callback?error=access_denied&error_description=user_cancelled',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'oauth_provider_error',
      provider: 'openai-codex',
      providerError: 'access_denied',
    });
  });

  it('fails callback when state is invalid', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/oauth/openai-codex/callback?state=bad-state&code=abc123',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'oauth_callback_failed',
    });
  });
});

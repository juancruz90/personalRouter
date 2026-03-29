import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'BACKUP_DIR',
  'TOKEN_VAULT_MASTER_KEY',
  'TOKEN_REFRESH_INTERVAL_MS',
  'HEALTH_CHECK_INTERVAL_MINUTES',
  'BACKUP_INTERVAL_HOURS',
  'SINGLE_AGENT_MODE',
  'SINGLE_AGENT_SLUG',
  'AGENT_PERMISSIONS_ENABLED',
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

interface ApiResponse<T = unknown> {
  status: number;
  json: T;
}

async function requestJson<T = unknown>(
  baseUrl: string,
  method: string,
  endpoint: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResponse<T>> {
  const hasBody = typeof body !== 'undefined';

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  const json = await response.json() as T;

  return {
    status: response.status,
    json,
  };
}

describe('E2E happy path', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;
  let backupsDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-e2e-happy-'));
    backupsDir = path.join(tempDir, 'backups');
    const dbPath = path.join(tempDir, 'ocom.db');

    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.BACKUP_DIR = backupsDir;
    process.env.TOKEN_VAULT_MASTER_KEY = 'e2e-happy-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
    process.env.BACKUP_INTERVAL_HOURS = '0';
    process.env.SINGLE_AGENT_MODE = 'true';
    process.env.SINGLE_AGENT_SLUG = 'florencia';
    process.env.AGENT_PERMISSIONS_ENABLED = 'false';
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

  it('covers seed, account lifecycle, routing failover and monitoring artifacts', async () => {
    const server = createServer();
    servers.push(server);

    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = address;

    const health = await requestJson<{ healthy: boolean }>(baseUrl, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json.healthy).toBe(true);

    const seed = await requestJson<{ ok: boolean; agents: Array<{ slug: string }> }>(baseUrl, 'POST', '/seed/personal-provider');
    expect(seed.status).toBe(200);
    expect(seed.json.ok).toBe(true);
    expect(seed.json.agents.some((agent) => agent.slug === 'florencia')).toBe(true);

    const createPrimary = await requestJson<{ account: { id: number } }>(baseUrl, 'POST', '/accounts', {
      provider: 'openai-codex',
      accountId: 'acct-e2e-primary',
      profileId: 'openai-codex:e2e-primary',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      refreshToken: 'refresh-e2e-primary',
      accessToken: 'access-e2e-primary',
    });

    const createFallback = await requestJson<{ account: { id: number } }>(baseUrl, 'POST', '/accounts', {
      provider: 'openai-codex',
      accountId: 'acct-e2e-fallback',
      profileId: 'openai-codex:e2e-fallback',
      expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
      healthScore: 45,
      accessToken: 'access-e2e-fallback',
    });

    expect(createPrimary.status).toBe(201);
    expect(createFallback.status).toBe(201);

    const primaryId = createPrimary.json.account.id;
    const fallbackId = createFallback.json.account.id;

    const bindPrimary = await requestJson(baseUrl, 'POST', '/assignments', {
      accountId: primaryId,
      priority: 1,
      mode: 'primary',
    });

    const bindFallback = await requestJson(baseUrl, 'POST', '/assignments', {
      accountId: fallbackId,
      priority: 2,
      mode: 'fallback',
    });

    expect(bindPrimary.status).toBe(200);
    expect(bindFallback.status).toBe(200);

    const selectedBefore = await requestJson<{ account: { id: number }; failoverApplied: boolean }>(
      baseUrl,
      'GET',
      '/agents/florencia/active-account?provider=openai-codex',
    );

    expect(selectedBefore.status).toBe(200);
    expect(selectedBefore.json.account.id).toBe(primaryId);
    expect(selectedBefore.json.failoverApplied).toBe(false);

    const revokePrimary = await requestJson(baseUrl, 'DELETE', `/accounts/${primaryId}`);
    expect(revokePrimary.status).toBe(200);

    const selectedAfter = await requestJson<{ account: { id: number }; failoverApplied: boolean }>(
      baseUrl,
      'GET',
      '/agents/florencia/active-account?provider=openai-codex',
    );

    expect(selectedAfter.status).toBe(200);
    expect(selectedAfter.json.account.id).toBe(fallbackId);
    expect(selectedAfter.json.failoverApplied).toBe(true);

    const runHealth = await requestJson<{ ok: boolean; scanned: number }>(baseUrl, 'POST', '/health/run', {
      provider: 'openai-codex',
    });

    expect(runHealth.status).toBe(200);
    expect(runHealth.json.ok).toBe(true);
    expect(runHealth.json.scanned).toBeGreaterThanOrEqual(2);

    const backup = await requestJson<{ ok: boolean; backup: { file: string } }>(baseUrl, 'POST', '/backup/run');
    expect(backup.status).toBe(200);
    expect(backup.json.ok).toBe(true);

    const events = await requestJson<{ events: Array<{ type: string }> }>(baseUrl, 'GET', '/events/recent?limit=50');
    expect(events.status).toBe(200);
    const eventTypes = events.json.events.map((event) => event.type);
    expect(eventTypes).toContain('seed.personal_provider');
    expect(eventTypes).toContain('account.revoked');
    expect(eventTypes).toContain('backup.run');
  }, 20000);
});

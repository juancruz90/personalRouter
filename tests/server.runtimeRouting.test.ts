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

describe('server runtime routing', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-runtime-routing-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'runtime-routing-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
    process.env.BACKUP_INTERVAL_HOURS = '0';
    process.env.ACCOUNT_RUNTIME_RECOVER_INTERVAL_MINUTES = '0';
    process.env.OAUTH_CALLBACK_BRIDGE_ENABLED = 'false';
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

  it('fails over to fallback when primary runtime state is exhausted', async () => {
    const server = createServer();
    servers.push(server);

    const primary = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-runtime-primary',
        profileId: 'runtime-primary',
      },
    });

    const fallback = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-runtime-fallback',
        profileId: 'runtime-fallback',
      },
    });

    const primaryId = primary.json().account.id as number;
    const fallbackId = fallback.json().account.id as number;

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'florencia',
        accountId: primaryId,
        priority: 1,
        mode: 'primary',
      },
    });

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'florencia',
        accountId: fallbackId,
        priority: 2,
        mode: 'fallback',
      },
    });

    const before = await server.inject({
      method: 'GET',
      url: '/agents/florencia/active-account?provider=openai-codex',
    });

    expect(before.statusCode).toBe(200);
    expect(before.json().account.id).toBe(primaryId);

    const markExhausted = await server.inject({
      method: 'POST',
      url: `/accounts/${primaryId}/runtime-event`,
      payload: {
        outcome: 'exhausted',
        errorCode: 'quota_exceeded',
      },
    });

    expect(markExhausted.statusCode).toBe(200);

    const after = await server.inject({
      method: 'GET',
      url: '/agents/florencia/active-account?provider=openai-codex',
    });

    expect(after.statusCode).toBe(200);
    expect(after.json().account.id).toBe(fallbackId);
    expect(after.json().failoverApplied).toBe(true);
  });

  it('prefers rotating to another openai-codex profile before other providers', async () => {
    const server = createServer();
    servers.push(server);

    const codexPrimary = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-codex-primary',
        profileId: 'codex-primary',
      },
    });

    const codexSecondary = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-codex-secondary',
        profileId: 'codex-secondary',
      },
    });

    const otherProvider = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openrouter',
        accountId: 'acct-openrouter-fallback',
        profileId: 'openrouter-fallback',
      },
    });

    const primaryId = codexPrimary.json().account.id as number;
    const secondaryId = codexSecondary.json().account.id as number;
    const otherId = otherProvider.json().account.id as number;

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: { agentSlug: 'florencia', accountId: primaryId, priority: 1, mode: 'primary' },
    });

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: { agentSlug: 'florencia', accountId: otherId, priority: 2, mode: 'fallback' },
    });

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: { agentSlug: 'florencia', accountId: secondaryId, priority: 3, mode: 'fallback' },
    });

    await server.inject({
      method: 'POST',
      url: `/accounts/${primaryId}/runtime-event`,
      payload: { outcome: 'exhausted', errorCode: 'quota_exceeded' },
    });

    const active = await server.inject({
      method: 'GET',
      url: '/agents/florencia/active-account',
    });

    expect(active.statusCode).toBe(200);
    expect(active.json().account.id).toBe(secondaryId);
    expect(active.json().account.provider).toBe('openai-codex');
  });

  it('falls back to other provider only when all openai-codex profiles are exhausted', async () => {
    const server = createServer();
    servers.push(server);

    const codexPrimary = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-codex-primary-2',
        profileId: 'codex-primary-2',
      },
    });

    const codexSecondary = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-codex-secondary-2',
        profileId: 'codex-secondary-2',
      },
    });

    const otherProvider = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openrouter',
        accountId: 'acct-openrouter-fallback-2',
        profileId: 'openrouter-fallback-2',
      },
    });

    const primaryId = codexPrimary.json().account.id as number;
    const secondaryId = codexSecondary.json().account.id as number;
    const otherId = otherProvider.json().account.id as number;

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: { agentSlug: 'florencia', accountId: primaryId, priority: 1, mode: 'primary' },
    });

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: { agentSlug: 'florencia', accountId: secondaryId, priority: 2, mode: 'fallback' },
    });

    await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: { agentSlug: 'florencia', accountId: otherId, priority: 3, mode: 'fallback' },
    });

    await server.inject({
      method: 'POST',
      url: `/accounts/${primaryId}/runtime-event`,
      payload: { outcome: 'exhausted', errorCode: 'quota_exceeded' },
    });

    await server.inject({
      method: 'POST',
      url: `/accounts/${secondaryId}/runtime-event`,
      payload: { outcome: 'exhausted', errorCode: 'quota_exceeded' },
    });

    const active = await server.inject({
      method: 'GET',
      url: '/agents/florencia/active-account',
    });

    expect(active.statusCode).toBe(200);
    expect(active.json().account.id).toBe(otherId);
    expect(active.json().account.provider).toBe('openrouter');
  });

  it('classifies insufficient_quota body as exhausted during runtime probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
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
        accountId: 'acct-probe-quota',
        profileId: 'probe-quota',
        accessToken: 'atk-probe-quota',
      },
    });

    expect(created.statusCode).toBe(201);

    const probe = await server.inject({
      method: 'POST',
      url: '/accounts/runtime/probe',
      payload: {
        provider: 'openai-codex',
      },
    });

    expect(probe.statusCode).toBe(200);
    expect(probe.json().summary.exhausted).toBe(1);
    expect(probe.json().statusSummary.exhausted).toBe(1);
    expect(probe.json().results[0]).toMatchObject({
      outcome: 'exhausted',
      quotaStatus: 'exhausted',
      quotaRemainingPct: 0,
      errorCode: 'insufficient_quota',
    });
  });

  it('marks account as limited when usage is high but not exhausted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 92,
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
        accountId: 'acct-probe-limited',
        profileId: 'probe-limited',
        accessToken: 'atk-probe-limited',
      },
    });

    expect(created.statusCode).toBe(201);

    const probe = await server.inject({
      method: 'POST',
      url: '/accounts/runtime/probe',
      payload: {
        provider: 'openai-codex',
      },
    });

    expect(probe.statusCode).toBe(200);
    expect(probe.json().summary.degraded).toBe(1);
    expect(probe.json().statusSummary.limited).toBe(1);
    expect(probe.json().results[0]).toMatchObject({
      outcome: 'degraded',
      quotaStatus: 'limited',
      quotaRemainingPct: 8,
      usedPercent: 92,
      resetAt: 1770000000,
    });
  });
});

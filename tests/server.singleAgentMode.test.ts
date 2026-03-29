import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
  'TOKEN_REFRESH_INTERVAL_MS',
  'HEALTH_CHECK_INTERVAL_MINUTES',
  'BACKUP_INTERVAL_HOURS',
  'SINGLE_AGENT_MODE',
  'SINGLE_AGENT_SLUG',
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

describe('server single-agent mode', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-single-agent-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'single-agent-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
    process.env.BACKUP_INTERVAL_HOURS = '0';
    process.env.SINGLE_AGENT_MODE = 'true';
    process.env.SINGLE_AGENT_SLUG = 'florencia';
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

  it('enforces explicit single-agent slug in routing and assignments', async () => {
    const server = createServer();
    servers.push(server);

    const mode = await server.inject({ method: 'GET', url: '/mode' });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toMatchObject({
      ok: true,
      mode: {
        singleAgent: true,
        agentSlug: 'florencia',
      },
    });

    const account = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-single-1',
        profileId: 'openai-codex:single-1',
      },
    });
    expect(account.statusCode).toBe(201);

    const accountId = account.json().account.id as number;

    const assignment = await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        accountId,
      },
    });

    expect(assignment.statusCode).toBe(200);
    expect(assignment.json().assignment.agentSlug).toBe('florencia');

    const mismatchWrite = await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'condor',
        accountId,
      },
    });

    expect(mismatchWrite.statusCode).toBe(409);
    expect(mismatchWrite.json().error).toBe('single_agent_slug_mismatch');

    const mismatchRead = await server.inject({
      method: 'GET',
      url: '/assignments?agentSlug=condor',
    });

    expect(mismatchRead.statusCode).toBe(409);

    const mismatchRoute = await server.inject({
      method: 'GET',
      url: '/router/condor/select',
    });

    expect(mismatchRoute.statusCode).toBe(409);
  });
});

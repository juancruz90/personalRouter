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

describe('server agent permission middleware', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-agent-permissions-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'agent-permissions-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
    process.env.BACKUP_INTERVAL_HOURS = '0';
    process.env.SINGLE_AGENT_MODE = 'false';
    process.env.AGENT_PERMISSIONS_ENABLED = 'true';
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

  it('requires x-agent-slug and enforces route ownership', async () => {
    const server = createServer();
    servers.push(server);

    const account = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-perm-1',
        profileId: 'openai-codex:perm-1',
      },
    });

    expect(account.statusCode).toBe(201);
    const accountId = account.json().account.id as number;

    const missingHeader = await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'florencia',
        accountId,
      },
    });

    expect(missingHeader.statusCode).toBe(401);
    expect(missingHeader.json().error).toBe('missing_agent_slug_header');

    const mismatchedHeader = await server.inject({
      method: 'POST',
      url: '/assignments',
      headers: {
        'x-agent-slug': 'condor',
      },
      payload: {
        agentSlug: 'florencia',
        accountId,
      },
    });

    expect(mismatchedHeader.statusCode).toBe(403);
    expect(mismatchedHeader.json().error).toBe('agent_slug_forbidden');

    const createAssignment = await server.inject({
      method: 'POST',
      url: '/assignments',
      headers: {
        'x-agent-slug': 'florencia',
      },
      payload: {
        agentSlug: 'florencia',
        accountId,
      },
    });

    expect(createAssignment.statusCode).toBe(200);
    const assignmentId = createAssignment.json().assignment.id as number;

    const listMissingHeader = await server.inject({
      method: 'GET',
      url: '/assignments?agentSlug=florencia',
    });

    expect(listMissingHeader.statusCode).toBe(401);

    const listWrongHeader = await server.inject({
      method: 'GET',
      url: '/assignments?agentSlug=florencia',
      headers: {
        'x-agent-slug': 'condor',
      },
    });

    expect(listWrongHeader.statusCode).toBe(403);

    const listCorrectHeader = await server.inject({
      method: 'GET',
      url: '/assignments?agentSlug=florencia',
      headers: {
        'x-agent-slug': 'florencia',
      },
    });

    expect(listCorrectHeader.statusCode).toBe(200);
    expect(listCorrectHeader.json().assignments).toHaveLength(1);

    const routerWrongHeader = await server.inject({
      method: 'GET',
      url: '/router/florencia/select',
      headers: {
        'x-agent-slug': 'condor',
      },
    });

    expect(routerWrongHeader.statusCode).toBe(403);

    const deleteWrongHeader = await server.inject({
      method: 'DELETE',
      url: `/assignments/${assignmentId}`,
      headers: {
        'x-agent-slug': 'condor',
      },
    });

    expect(deleteWrongHeader.statusCode).toBe(403);

    const deleteCorrectHeader = await server.inject({
      method: 'DELETE',
      url: `/assignments/${assignmentId}`,
      headers: {
        'x-agent-slug': 'florencia',
      },
    });

    expect(deleteCorrectHeader.statusCode).toBe(200);
  });
});

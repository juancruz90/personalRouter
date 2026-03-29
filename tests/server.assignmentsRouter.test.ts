import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

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

describe('server assignments + router routes', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-router-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-router-master-key';
  });

  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }

    delete process.env.DATABASE_PATH;
    delete process.env.TOKEN_VAULT_MASTER_KEY;

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('binds assignments and selects account with failover', async () => {
    const server = createServer();
    servers.push(server);

    const accountAResponse = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-a',
        profileId: 'openai-codex:a',
        healthScore: 95,
      },
    });

    const accountBResponse = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-b',
        profileId: 'openai-codex:b',
        healthScore: 40,
      },
    });

    expect(accountAResponse.statusCode).toBe(201);
    expect(accountBResponse.statusCode).toBe(201);

    const accountA = accountAResponse.json().account;
    const accountB = accountBResponse.json().account;

    const assignA = await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'florencia',
        accountId: accountA.id,
        priority: 1,
        mode: 'primary',
      },
    });

    const assignB = await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'florencia',
        accountId: accountB.id,
        priority: 2,
        mode: 'fallback',
      },
    });

    expect(assignA.statusCode).toBe(200);
    expect(assignB.statusCode).toBe(200);

    const initialSelect = await server.inject({
      method: 'GET',
      url: '/router/florencia/select?provider=openai-codex',
    });

    expect(initialSelect.statusCode).toBe(200);
    expect(initialSelect.json().selected.accountId).toBe(accountA.id);
    expect(initialSelect.json().failoverApplied).toBe(false);

    const initialActiveAccount = await server.inject({
      method: 'GET',
      url: '/agents/florencia/active-account?provider=openai-codex',
    });

    expect(initialActiveAccount.statusCode).toBe(200);
    expect(initialActiveAccount.json().account.id).toBe(accountA.id);
    expect(initialActiveAccount.json().failoverApplied).toBe(false);

    const revokeA = await server.inject({
      method: 'POST',
      url: `/accounts/${accountA.id}/revoke`,
    });
    expect(revokeA.statusCode).toBe(200);

    const afterFailover = await server.inject({
      method: 'GET',
      url: '/router/florencia/select?provider=openai-codex',
    });

    expect(afterFailover.statusCode).toBe(200);
    expect(afterFailover.json().selected.accountId).toBe(accountB.id);
    expect(afterFailover.json().failoverApplied).toBe(true);

    const afterFailoverActive = await server.inject({
      method: 'GET',
      url: '/agents/florencia/active-account?provider=openai-codex',
    });

    expect(afterFailoverActive.statusCode).toBe(200);
    expect(afterFailoverActive.json().account.id).toBe(accountB.id);
    expect(afterFailoverActive.json().failoverApplied).toBe(true);

    const missingActive = await server.inject({
      method: 'GET',
      url: '/agents/no-assignments/active-account?provider=openai-codex',
    });

    expect(missingActive.statusCode).toBe(404);
    expect(missingActive.json().error).toBe('no_assignments');

    const assignmentsList = await server.inject({ method: 'GET', url: '/assignments?agentSlug=florencia' });
    expect(assignmentsList.statusCode).toBe(200);
    expect(assignmentsList.json().assignments).toHaveLength(2);

    const deleteOne = await server.inject({
      method: 'DELETE',
      url: `/assignments/${assignB.json().assignment.id}`,
    });

    expect(deleteOne.statusCode).toBe(200);
    expect(deleteOne.json().removed).toBe(true);
  });
});

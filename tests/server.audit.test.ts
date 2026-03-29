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

describe('server audit routes + hooks', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-audit-'));
    const dbPath = path.join(tempDir, 'ocom.db');

    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'audit-server-master-key';
    process.env.AUDIT_HMAC_KEY = 'audit-server-hmac-key';
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
    delete process.env.AUDIT_HMAC_KEY;

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records append-only HMAC audit entries for mutating account + assignment actions', async () => {
    const server = createServer();
    servers.push(server);

    const accountResponse = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-audit',
        profileId: 'openai-codex:audit',
        healthScore: 90,
        actor: 'florencia',
      },
    });

    expect(accountResponse.statusCode).toBe(201);
    const account = accountResponse.json().account;

    const assignmentResponse = await server.inject({
      method: 'POST',
      url: '/assignments',
      payload: {
        agentSlug: 'florencia',
        accountId: account.id,
        priority: 1,
        mode: 'primary',
        actor: 'florencia',
      },
    });

    expect(assignmentResponse.statusCode).toBe(200);

    const revokeResponse = await server.inject({
      method: 'POST',
      url: `/accounts/${account.id}/revoke`,
      payload: { actor: 'florencia' },
    });

    expect(revokeResponse.statusCode).toBe(200);

    const auditResponse = await server.inject({
      method: 'GET',
      url: '/audit?limit=10',
    });

    expect(auditResponse.statusCode).toBe(200);

    const entries = auditResponse.json().entries;
    const actions = entries.map((entry: { action: string }) => entry.action);

    expect(actions).toContain('account.create');
    expect(actions).toContain('assignment.upsert');
    expect(actions).toContain('account.revoke');
    expect(entries.every((entry: { valid: boolean }) => entry.valid)).toBe(true);
  });
});

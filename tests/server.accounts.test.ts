import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

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

describe('server accounts routes', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-accounts-'));
    const dbPath = path.join(tempDir, 'ocom.db');

    await initializeAccountsTable(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-test-master-key';
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

  it('creates, lists, checks status and revokes an account', async () => {
    const server = createServer();
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-100',
        profileId: 'openai-codex:default',
        healthScore: 95,
        accessToken: 'sk-secret-token',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().account;
    expect(created.status).toBe('active');

    const listResponse = await server.inject({
      method: 'GET',
      url: '/accounts?provider=openai-codex',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().accounts).toHaveLength(1);

    const statusResponse = await server.inject({
      method: 'GET',
      url: `/accounts/${created.id}/status`,
    });

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      ok: true,
      id: created.id,
      status: 'active',
      locked: false,
    });

    const revokeResponse = await server.inject({
      method: 'POST',
      url: `/accounts/${created.id}/revoke`,
    });

    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json().account.status).toBe('revoked');

    const filteredList = await server.inject({
      method: 'GET',
      url: '/accounts?includeRevoked=0',
    });

    expect(filteredList.statusCode).toBe(200);
    expect(filteredList.json().accounts).toHaveLength(0);
  });

  it('supports DELETE /accounts/:id as revoke alias', async () => {
    const server = createServer();
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
        accountId: 'acct-200',
        profileId: 'openai-codex:delete',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().account;

    const revokeResponse = await server.inject({
      method: 'DELETE',
      url: `/accounts/${created.id}`,
    });

    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json().account.status).toBe('revoked');
  });

  it('validates required fields on account creation', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        provider: 'openai-codex',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'validation_error',
      target: 'body',
    });
  });
});

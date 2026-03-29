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

function waitForWsOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('error', onError);
      resolve();
    };

    const onError = () => {
      socket.removeEventListener('open', onOpen);
      reject(new Error('websocket failed to open'));
    };

    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function toTextPayload(data: unknown): Promise<string> {
  if (typeof data === 'string') {
    return Promise.resolve(data);
  }

  if (data instanceof ArrayBuffer) {
    return Promise.resolve(Buffer.from(data).toString('utf8'));
  }

  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }

  return Promise.resolve(String(data));
}

function waitForWsEvent(
  socket: WebSocket,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('timed out waiting websocket event'));
    }, timeoutMs);

    const onMessage = (message: MessageEvent) => {
      toTextPayload(message.data).then((raw) => {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (predicate(parsed)) {
            clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            resolve(parsed);
          }
        } catch {
          // ignore non-json frames
        }
      }).catch(() => {
        // ignore payload parse errors
      });
    };

    socket.addEventListener('message', onMessage);
  });
}

describe('server websocket events', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-ws-'));
    const dbPath = path.join(tempDir, 'ocom.db');
    await initializeSchema(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-ws-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
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

  it('broadcasts account.created events to websocket clients', async () => {
    const server = createServer();
    servers.push(server);

    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const url = new URL(address);

    const ws = new WebSocket(`ws://${url.host}/ws/events?replay=1`);

    try {
      await waitForWsOpen(ws);

      const eventPromise = waitForWsEvent(ws, (event) => event.type === 'account.created');

      const create = await server.inject({
        method: 'POST',
        url: '/accounts',
        payload: {
          provider: 'openai-codex',
          accountId: 'acct-ws-1',
          profileId: 'openai-codex:ws-1',
        },
      });

      expect(create.statusCode).toBe(201);

      const received = await eventPromise;
      expect(received.type).toBe('account.created');

      const payload = received.payload as Record<string, unknown>;
      expect(payload.provider).toBe('openai-codex');
      expect(payload.profileId).toBe('openai-codex:ws-1');
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.addEventListener('close', () => resolve(), { once: true });
          ws.close();
        });
      }
    }
  }, 15000);
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
  'BACKUP_DIR',
  'BACKUP_INTERVAL_HOURS',
  'TOKEN_REFRESH_INTERVAL_MS',
  'HEALTH_CHECK_INTERVAL_MINUTES',
] as const;

function initializeDb(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
      }
    });

    db.serialize(() => {
      db.run('CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY, name TEXT)', (runErr) => {
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
      });
    });
  });
}

describe('server backup routes', () => {
  let tempDir: string;
  let dbPath: string;
  let backupsDir: string;
  const servers: Array<ReturnType<typeof createServer>> = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-backup-'));
    dbPath = path.join(tempDir, 'ocom.db');
    backupsDir = path.join(tempDir, 'backups');

    await initializeDb(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.BACKUP_DIR = backupsDir;
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-backup-master-key';
    process.env.BACKUP_INTERVAL_HOURS = '0';
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

  it('runs backup, lists artifacts and restores a selected snapshot', async () => {
    const server = createServer();
    servers.push(server);

    const run = await server.inject({
      method: 'POST',
      url: '/backup/run',
    });

    expect(run.statusCode).toBe(200);
    const runPayload = run.json();
    expect(runPayload.ok).toBe(true);
    expect(runPayload.backup.file).toContain('.db');

    const backupFile = runPayload.backup.file as string;

    const list = await server.inject({
      method: 'GET',
      url: '/backup/list',
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().backups.length).toBeGreaterThanOrEqual(1);

    fs.writeFileSync(dbPath, 'corrupted-db', 'utf8');

    const restore = await server.inject({
      method: 'POST',
      url: '/backup/restore',
      payload: {
        file: backupFile,
      },
    });

    expect(restore.statusCode).toBe(200);
    expect(restore.json().ok).toBe(true);

    const restoredContent = fs.readFileSync(dbPath);
    expect(restoredContent.toString('utf8', 0, 15)).toBe('SQLite format 3');

    const backupStat = fs.statSync(path.join(backupsDir, backupFile));
    const restoredStat = fs.statSync(dbPath);
    expect(restoredStat.size).toBeGreaterThanOrEqual(backupStat.size);
  });
});

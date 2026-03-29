import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backupService';

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

describe('BackupService', () => {
  let tempDir: string;
  let dbPath: string;
  let backupsDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-backup-'));
    dbPath = path.join(tempDir, 'ocom.db');
    backupsDir = path.join(tempDir, 'backups');
    await initializeDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates backups and restores a previous snapshot', () => {
    const service = new BackupService(dbPath, backupsDir);

    fs.writeFileSync(dbPath, 'version-a', 'utf8');
    const first = service.runBackup(new Date('2026-03-25T00:00:00.000Z'));

    fs.writeFileSync(dbPath, 'version-b', 'utf8');
    const second = service.runBackup(new Date('2026-03-25T01:00:00.000Z'));

    expect(first.file).not.toBe(second.file);

    const listed = service.listBackups();
    expect(listed.length).toBeGreaterThanOrEqual(2);

    service.restoreBackup(first.file);
    const restored = fs.readFileSync(dbPath, 'utf8');
    expect(restored).toBe('version-a');
  });
});

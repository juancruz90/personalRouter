import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/auditService';

function initializeAuditTable(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
      }
    });

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
}

function tamperPayload(dbPath: string, id: number): Promise<Error> {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath);
    db.run(
      `UPDATE audit_log SET payload = '{"tampered":true}' WHERE id = ?`,
      [id],
      (err) => {
        db.close(() => {
          resolve(err || new Error('Expected append-only trigger to block UPDATE on audit_log'));
        });
      },
    );
  });
}

function insertForgedRow(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.run(
      `
      INSERT INTO audit_log (
        actor,
        action,
        resource_type,
        resource_id,
        payload,
        hmac,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        'forged-actor',
        'forged.action',
        'account',
        '999',
        '{"forged":true}',
        'invalid-hmac',
        new Date().toISOString(),
      ],
      (err) => {
        db.close(() => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      },
    );
  });
}

describe('AuditService', () => {
  let tempDir: string;
  let dbPath: string;
  let audit: AuditService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-audit-'));
    dbPath = path.join(tempDir, 'ocom.db');

    await initializeAuditTable(dbPath);
    audit = new AuditService(dbPath, 'audit-secret-test');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends and validates audit rows with HMAC', async () => {
    const created = await audit.append({
      actor: 'florencia',
      action: 'account.create',
      resourceType: 'account',
      resourceId: '1',
      payload: { provider: 'openai-codex', accountId: 'acct-1' },
    });

    expect(created.valid).toBe(true);
    expect(created.hmac).toMatch(/^[a-f0-9]{64}$/);

    const list = await audit.list(10);
    expect(list).toHaveLength(1);
    expect(list[0].valid).toBe(true);
    expect(list[0].action).toBe('account.create');
  });

  it('blocks direct UPDATE tampering with append-only triggers', async () => {
    const created = await audit.append({
      actor: 'florencia',
      action: 'assignment.upsert',
      resourceType: 'assignment',
      resourceId: '10',
      payload: { priority: 1 },
    });

    const error = await tamperPayload(dbPath, created.id);
    expect(error.message).toContain('append-only');

    const list = await audit.list(10);
    expect(list[0].id).toBe(created.id);
    expect(list[0].valid).toBe(true);
  });

  it('detects forged rows that bypassed normal append flow', async () => {
    await insertForgedRow(dbPath);

    const list = await audit.list(10);
    expect(list).toHaveLength(1);
    expect(list[0].action).toBe('forged.action');
    expect(list[0].valid).toBe(false);
  });
});

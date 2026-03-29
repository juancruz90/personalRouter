import crypto from 'crypto';
import sqlite3 from 'sqlite3';

export interface AuditEntryInput {
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload?: unknown;
  createdAt?: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload: string;
  hmac: string;
  createdAt: string;
  valid: boolean;
}

interface AuditRow {
  id: number;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  payload: string;
  hmac: string;
  created_at: string;
}

function openDatabase(dbPath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(db);
    });
  });
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function runStatement(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        lastID: this.lastID || 0,
        changes: this.changes || 0,
      });
    });
  });
}

function getOne<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

function getAll<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((rows || []) as T[]);
    });
  });
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const normalize = (input: unknown): unknown => {
    if (input === null || input === undefined) {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((item) => normalize(item));
    }

    if (typeof input === 'object') {
      if (seen.has(input as object)) {
        return '[Circular]';
      }
      seen.add(input as object);

      const source = input as Record<string, unknown>;
      const sortedKeys = Object.keys(source).sort();
      const output: Record<string, unknown> = {};

      for (const key of sortedKeys) {
        output[key] = normalize(source[key]);
      }

      return output;
    }

    return input;
  };

  return JSON.stringify(normalize(value) ?? null);
}

function mapRow(row: AuditRow, valid: boolean): AuditEntry {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: row.payload,
    hmac: row.hmac,
    createdAt: row.created_at,
    valid,
  };
}

export class AuditService {
  constructor(
    private readonly dbPath: string,
    private readonly secret: string,
  ) {
    if (!secret || !secret.trim()) {
      throw new Error('Audit secret is required');
    }
  }

  private async ensureSchema(db: sqlite3.Database): Promise<void> {
    await runStatement(
      db,
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
    );
  }

  private async ensureAppendOnlyGuards(db: sqlite3.Database): Promise<void> {
    await runStatement(
      db,
      `
        CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only');
        END
      `,
    );

    await runStatement(
      db,
      `
        CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only');
        END
      `,
    );
  }

  private async withDatabase<T>(work: (db: sqlite3.Database) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.dbPath);

    try {
      await this.ensureSchema(db);
      await this.ensureAppendOnlyGuards(db);
      return await work(db);
    } finally {
      await closeDatabase(db);
    }
  }

  private computeHmac(entry: {
    actor: string;
    action: string;
    resourceType: string;
    resourceId: string;
    payload: string;
    createdAt: string;
  }): string {
    const payload = [
      entry.actor,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.payload,
      entry.createdAt,
    ].join('|');

    return crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  private verifyRow(row: AuditRow): boolean {
    const expected = this.computeHmac({
      actor: row.actor,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      payload: row.payload,
      createdAt: row.created_at,
    });

    return expected === row.hmac;
  }

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    const createdAt = input.createdAt || new Date().toISOString();
    const payload = stableStringify(input.payload);

    const hmac = this.computeHmac({
      actor: input.actor,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      payload,
      createdAt,
    });

    return this.withDatabase(async (db) => {
      const inserted = await runStatement(
        db,
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
          input.actor,
          input.action,
          input.resourceType,
          input.resourceId,
          payload,
          hmac,
          createdAt,
        ],
      );

      const row = await getOne<AuditRow>(
        db,
        `
          SELECT id, actor, action, resource_type, resource_id, payload, hmac, created_at
          FROM audit_log
          WHERE id = ?
        `,
        [inserted.lastID],
      );

      if (!row) {
        throw new Error('Failed to fetch appended audit row');
      }

      return mapRow(row, this.verifyRow(row));
    });
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    return this.withDatabase(async (db) => {
      const rows = await getAll<AuditRow>(
        db,
        `
          SELECT id, actor, action, resource_type, resource_id, payload, hmac, created_at
          FROM audit_log
          ORDER BY id DESC
          LIMIT ?
        `,
        [limit],
      );

      return rows.map((row) => mapRow(row, this.verifyRow(row)));
    });
  }
}

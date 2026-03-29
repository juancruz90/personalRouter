import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

export type RuntimeState = 'healthy' | 'degraded' | 'exhausted';
export type RuntimeOutcome = 'success' | 'degraded' | 'exhausted';

interface RuntimeRow {
  account_id: number;
  state: RuntimeState;
  exhausted_until: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
}

export interface AccountRuntimeView {
  accountId: number;
  state: RuntimeState;
  exhaustedUntil: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
}

export interface RuntimeEventInput {
  accountId: number;
  outcome: RuntimeOutcome;
  errorCode?: string;
  errorMessage?: string;
}

function openDatabase(dbPath: string): Promise<sqlite3.Database> {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

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

function runStatement(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ changes: this.changes || 0 });
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

function mapRuntimeRow(row: RuntimeRow): AccountRuntimeView {
  return {
    accountId: row.account_id,
    state: row.state,
    exhaustedUntil: row.exhausted_until,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    updatedAt: row.updated_at,
  };
}

export class AccountRuntimeService {
  constructor(
    private readonly dbPath: string,
    private readonly resetWindowHours = 24,
  ) {}

  private async withDatabase<T>(work: (db: sqlite3.Database) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.dbPath);

    try {
      await this.ensureSchema(db);
      return await work(db);
    } finally {
      await closeDatabase(db);
    }
  }

  private async ensureSchema(db: sqlite3.Database): Promise<void> {
    await runStatement(
      db,
      `
        CREATE TABLE IF NOT EXISTS account_runtime (
          account_id INTEGER PRIMARY KEY,
          state TEXT NOT NULL,
          exhausted_until TEXT,
          last_success_at TEXT,
          last_error_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `,
    );
  }

  async list(accountIds?: number[]): Promise<AccountRuntimeView[]> {
    return this.withDatabase(async (db) => {
      let sql = `
        SELECT
          account_id,
          state,
          exhausted_until,
          last_success_at,
          last_error_at,
          last_error_code,
          last_error_message,
          updated_at
        FROM account_runtime
      `;
      const params: unknown[] = [];

      if (accountIds && accountIds.length) {
        const unique = Array.from(new Set(accountIds.filter((id) => Number.isInteger(id) && id > 0)));
        if (unique.length) {
          sql += ` WHERE account_id IN (${unique.map(() => '?').join(',')})`;
          params.push(...unique);
        }
      }

      sql += ' ORDER BY account_id ASC';

      const rows = await getAll<RuntimeRow>(db, sql, params);
      return rows.map(mapRuntimeRow);
    });
  }

  async listByAccountId(accountIds?: number[]): Promise<Record<number, AccountRuntimeView>> {
    const items = await this.list(accountIds);
    const map: Record<number, AccountRuntimeView> = {};
    for (const item of items) {
      map[item.accountId] = item;
    }
    return map;
  }

  async recordEvent(input: RuntimeEventInput): Promise<AccountRuntimeView> {
    return this.withDatabase(async (db) => {
      const now = new Date();
      const nowIso = now.toISOString();

      const nextState: RuntimeState = input.outcome === 'success'
        ? 'healthy'
        : input.outcome === 'exhausted'
          ? 'exhausted'
          : 'degraded';

      const exhaustedUntil = nextState === 'exhausted'
        ? new Date(now.getTime() + (this.resetWindowHours * 60 * 60_000)).toISOString()
        : null;

      await runStatement(
        db,
        `
          INSERT INTO account_runtime (
            account_id,
            state,
            exhausted_until,
            last_success_at,
            last_error_at,
            last_error_code,
            last_error_message,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(account_id) DO UPDATE SET
            state = excluded.state,
            exhausted_until = excluded.exhausted_until,
            last_success_at = CASE
              WHEN excluded.last_success_at IS NOT NULL THEN excluded.last_success_at
              ELSE account_runtime.last_success_at
            END,
            last_error_at = CASE
              WHEN excluded.last_error_at IS NOT NULL THEN excluded.last_error_at
              ELSE account_runtime.last_error_at
            END,
            last_error_code = CASE
              WHEN excluded.last_error_code IS NOT NULL THEN excluded.last_error_code
              ELSE account_runtime.last_error_code
            END,
            last_error_message = CASE
              WHEN excluded.last_error_message IS NOT NULL THEN excluded.last_error_message
              ELSE account_runtime.last_error_message
            END,
            updated_at = datetime('now')
        `,
        [
          input.accountId,
          nextState,
          exhaustedUntil,
          nextState === 'healthy' ? nowIso : null,
          nextState === 'healthy' ? null : nowIso,
          nextState === 'healthy' ? null : (input.errorCode || null),
          nextState === 'healthy' ? null : (input.errorMessage || null),
        ],
      );

      const byId = await this.listByAccountId([input.accountId]);
      return byId[input.accountId] || {
        accountId: input.accountId,
        state: nextState,
        exhaustedUntil,
        lastSuccessAt: nextState === 'healthy' ? nowIso : null,
        lastErrorAt: nextState === 'healthy' ? null : nowIso,
        lastErrorCode: nextState === 'healthy' ? null : (input.errorCode || null),
        lastErrorMessage: nextState === 'healthy' ? null : (input.errorMessage || null),
        updatedAt: nowIso,
      };
    });
  }

  async recoverDue(now = new Date()): Promise<AccountRuntimeView[]> {
    return this.withDatabase(async (db) => {
      const nowIso = now.toISOString();

      const due = await getAll<RuntimeRow>(
        db,
        `
          SELECT
            account_id,
            state,
            exhausted_until,
            last_success_at,
            last_error_at,
            last_error_code,
            last_error_message,
            updated_at
          FROM account_runtime
          WHERE state = 'exhausted'
            AND exhausted_until IS NOT NULL
            AND exhausted_until <= ?
          ORDER BY account_id ASC
        `,
        [nowIso],
      );

      if (!due.length) {
        return [];
      }

      const ids = due.map((item) => item.account_id);
      const placeholders = ids.map(() => '?').join(',');

      await runStatement(
        db,
        `
          UPDATE account_runtime
          SET state = 'degraded',
              exhausted_until = NULL,
              last_error_code = 'quota_reset',
              updated_at = datetime('now')
          WHERE account_id IN (${placeholders})
        `,
        ids,
      );

      const recovered = await getAll<RuntimeRow>(
        db,
        `
          SELECT
            account_id,
            state,
            exhausted_until,
            last_success_at,
            last_error_at,
            last_error_code,
            last_error_message,
            updated_at
          FROM account_runtime
          WHERE account_id IN (${placeholders})
          ORDER BY account_id ASC
        `,
        ids,
      );

      return recovered.map(mapRuntimeRow);
    });
  }
}

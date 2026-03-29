import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

interface UsageRow {
  provider: string;
  account_id: number;
  used_percent: number | null;
  allowed: number | null;
  limit_reached: number | null;
  reset_at: number | null;
  http_status: number;
  checked_at: string;
  updated_at: string;
}

export interface AccountUsageCacheItem {
  provider: string;
  accountId: number;
  usedPercent: number | null;
  allowed: boolean | null;
  limitReached: boolean | null;
  resetAt: number | null;
  httpStatus: number;
  checkedAt: string;
  updatedAt: string;
}

export interface UpsertUsageInput {
  provider: string;
  accountId: number;
  usedPercent: number | null;
  allowed: boolean | null;
  limitReached: boolean | null;
  resetAt: number | null;
  httpStatus: number;
  checkedAt?: string;
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

function runStatement(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
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

function mapUsageRow(row: UsageRow): AccountUsageCacheItem {
  return {
    provider: row.provider,
    accountId: row.account_id,
    usedPercent: typeof row.used_percent === 'number' ? row.used_percent : null,
    allowed: typeof row.allowed === 'number' ? row.allowed === 1 : null,
    limitReached: typeof row.limit_reached === 'number' ? row.limit_reached === 1 : null,
    resetAt: typeof row.reset_at === 'number' ? row.reset_at : null,
    httpStatus: row.http_status,
    checkedAt: row.checked_at,
    updatedAt: row.updated_at,
  };
}

export class AccountUsageCacheService {
  constructor(private readonly dbPath: string) {}

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
        CREATE TABLE IF NOT EXISTS account_usage_cache (
          provider TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          used_percent REAL,
          allowed INTEGER,
          limit_reached INTEGER,
          reset_at INTEGER,
          http_status INTEGER NOT NULL DEFAULT 0,
          checked_at TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (provider, account_id)
        )
      `,
    );
  }

  async upsert(input: UpsertUsageInput): Promise<void> {
    return this.withDatabase(async (db) => {
      const checkedAt = input.checkedAt || new Date().toISOString();

      await runStatement(
        db,
        `
          INSERT INTO account_usage_cache (
            provider,
            account_id,
            used_percent,
            allowed,
            limit_reached,
            reset_at,
            http_status,
            checked_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(provider, account_id) DO UPDATE SET
            used_percent = excluded.used_percent,
            allowed = excluded.allowed,
            limit_reached = excluded.limit_reached,
            reset_at = excluded.reset_at,
            http_status = excluded.http_status,
            checked_at = excluded.checked_at,
            updated_at = datetime('now')
        `,
        [
          input.provider,
          input.accountId,
          input.usedPercent,
          input.allowed == null ? null : (input.allowed ? 1 : 0),
          input.limitReached == null ? null : (input.limitReached ? 1 : 0),
          input.resetAt,
          input.httpStatus,
          checkedAt,
        ],
      );
    });
  }

  async listByProviderAndAccountIds(provider: string, accountIds: number[]): Promise<Record<number, AccountUsageCacheItem>> {
    return this.withDatabase(async (db) => {
      const unique = Array.from(new Set(accountIds.filter((id) => Number.isInteger(id) && id > 0)));
      if (!unique.length) {
        return {};
      }

      const rows = await getAll<UsageRow>(
        db,
        `
          SELECT provider, account_id, used_percent, allowed, limit_reached, reset_at, http_status, checked_at, updated_at
          FROM account_usage_cache
          WHERE provider = ?
            AND account_id IN (${unique.map(() => '?').join(',')})
        `,
        [provider, ...unique],
      );

      const byId: Record<number, AccountUsageCacheItem> = {};
      for (const row of rows) {
        const item = mapUsageRow(row);
        byId[item.accountId] = item;
      }
      return byId;
    });
  }
}

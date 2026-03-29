import sqlite3 from 'sqlite3';
import { AccountStatus, computeAccountStatus } from './accountStatus';

interface AssignmentRow {
  id: number;
  agent_slug: string;
  account_id: number;
  priority: number;
  mode: string;
  created_at: string;
  account_provider: string;
  account_external_id: string;
  account_profile_id: string;
  account_health_score: number;
  account_locked: number;
  account_expires_at: string | null;
}

export interface AssignmentView {
  id: number;
  agentSlug: string;
  accountId: number;
  priority: number;
  mode: string;
  createdAt: string;
  account: {
    provider: string;
    accountId: string;
    profileId: string;
    healthScore: number;
    status: AccountStatus;
    locked: boolean;
    expiresAt: string | null;
  };
}

export interface UpsertAssignmentInput {
  agentSlug: string;
  accountId: number;
  priority?: number;
  mode?: string;
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

function mapAssignmentRow(row: AssignmentRow): AssignmentView {
  const status = computeAccountStatus({
    locked: row.account_locked,
    expiresAt: row.account_expires_at,
    healthScore: row.account_health_score,
  });

  return {
    id: row.id,
    agentSlug: row.agent_slug,
    accountId: row.account_id,
    priority: row.priority,
    mode: row.mode,
    createdAt: row.created_at,
    account: {
      provider: row.account_provider,
      accountId: row.account_external_id,
      profileId: row.account_profile_id,
      healthScore: row.account_health_score,
      status,
      locked: Boolean(row.account_locked),
      expiresAt: row.account_expires_at,
    },
  };
}

export class AssignmentsService {
  constructor(private readonly dbPath: string) {}

  private async withDatabase<T>(work: (db: sqlite3.Database) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.dbPath);

    try {
      return await work(db);
    } finally {
      await closeDatabase(db);
    }
  }

  async list(options?: { agentSlug?: string; provider?: string }): Promise<AssignmentView[]> {
    return this.withDatabase(async (db) => {
      const params: unknown[] = [];
      const where: string[] = [];

      if (options?.agentSlug) {
        where.push('a.agent_slug = ?');
        params.push(options.agentSlug);
      }

      if (options?.provider) {
        where.push('acc.provider = ?');
        params.push(options.provider);
      }

      let sql = `
        SELECT
          a.id,
          a.agent_slug,
          a.account_id,
          a.priority,
          a.mode,
          a.created_at,
          acc.provider AS account_provider,
          acc.account_id AS account_external_id,
          acc.profile_id AS account_profile_id,
          acc.health_score AS account_health_score,
          acc.locked AS account_locked,
          acc.expires_at AS account_expires_at
        FROM assignments a
        JOIN accounts acc ON acc.id = a.account_id
      `;

      if (where.length) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }

      sql += ' ORDER BY a.agent_slug ASC, a.priority ASC, a.id ASC';

      const rows = await getAll<AssignmentRow>(db, sql, params);
      return rows.map(mapAssignmentRow);
    });
  }

  async getById(id: number): Promise<AssignmentView | null> {
    return this.withDatabase(async (db) => {
      const row = await getOne<AssignmentRow>(
        db,
        `
          SELECT
            a.id,
            a.agent_slug,
            a.account_id,
            a.priority,
            a.mode,
            a.created_at,
            acc.provider AS account_provider,
            acc.account_id AS account_external_id,
            acc.profile_id AS account_profile_id,
            acc.health_score AS account_health_score,
            acc.locked AS account_locked,
            acc.expires_at AS account_expires_at
          FROM assignments a
          JOIN accounts acc ON acc.id = a.account_id
          WHERE a.id = ?
        `,
        [id],
      );

      return row ? mapAssignmentRow(row) : null;
    });
  }

  async upsert(input: UpsertAssignmentInput): Promise<AssignmentView> {
    return this.withDatabase(async (db) => {
      const existing = await getOne<{ id: number }>(
        db,
        `
          SELECT id
          FROM assignments
          WHERE agent_slug = ? AND account_id = ?
        `,
        [input.agentSlug, input.accountId],
      );

      if (existing) {
        await runStatement(
          db,
          `
            UPDATE assignments
            SET priority = ?,
                mode = ?
            WHERE id = ?
          `,
          [input.priority ?? 100, input.mode || 'primary', existing.id],
        );

        const updatedRow = await getOne<AssignmentRow>(
          db,
          `
            SELECT
              a.id,
              a.agent_slug,
              a.account_id,
              a.priority,
              a.mode,
              a.created_at,
              acc.provider AS account_provider,
              acc.account_id AS account_external_id,
              acc.profile_id AS account_profile_id,
              acc.health_score AS account_health_score,
              acc.locked AS account_locked,
              acc.expires_at AS account_expires_at
            FROM assignments a
            JOIN accounts acc ON acc.id = a.account_id
            WHERE a.id = ?
          `,
          [existing.id],
        );

        if (!updatedRow) {
          throw new Error('Failed to fetch updated assignment');
        }

        return mapAssignmentRow(updatedRow);
      }

      const inserted = await runStatement(
        db,
        `
          INSERT INTO assignments (
            agent_slug,
            account_id,
            priority,
            mode,
            created_at
          ) VALUES (?, ?, ?, ?, datetime('now'))
        `,
        [
          input.agentSlug,
          input.accountId,
          input.priority ?? 100,
          input.mode || 'primary',
        ],
      );

      const createdRow = await getOne<AssignmentRow>(
        db,
        `
          SELECT
            a.id,
            a.agent_slug,
            a.account_id,
            a.priority,
            a.mode,
            a.created_at,
            acc.provider AS account_provider,
            acc.account_id AS account_external_id,
            acc.profile_id AS account_profile_id,
            acc.health_score AS account_health_score,
            acc.locked AS account_locked,
            acc.expires_at AS account_expires_at
          FROM assignments a
          JOIN accounts acc ON acc.id = a.account_id
          WHERE a.id = ?
        `,
        [inserted.lastID],
      );

      if (!createdRow) {
        throw new Error('Failed to fetch created assignment');
      }

      return mapAssignmentRow(createdRow);
    });
  }

  async removeById(id: number): Promise<boolean> {
    return this.withDatabase(async (db) => {
      const result = await runStatement(
        db,
        `
          DELETE FROM assignments
          WHERE id = ?
        `,
        [id],
      );

      return result.changes > 0;
    });
  }
}

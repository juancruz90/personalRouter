import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { TokenVault } from './tokenVault';
import { AccountStatus, computeAccountStatus } from './accountStatus';

interface AccountRow {
  id: number;
  provider: string;
  account_id: string;
  profile_id: string;
  expires_at: string | null;
  health_score: number;
  locked: number;
  created_at: string;
  updated_at: string;
}

interface AccountTokenRow extends AccountRow {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
}

export interface AccountView {
  id: number;
  provider: string;
  accountId: string;
  profileId: string;
  expiresAt: string | null;
  healthScore: number;
  locked: boolean;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  provider: string;
  accountId: string;
  profileId: string;
  expiresAt?: string | null;
  healthScore?: number;
  locked?: boolean;
  accessToken?: string;
  refreshToken?: string;
}

export interface RefreshCandidate {
  id: number;
  provider: string;
  accountId: string;
  profileId: string;
  refreshToken: string;
  expiresAt: string | null;
  healthScore: number;
}

export interface RotateTokensInput {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
  healthScore?: number;
}

export interface AccessTokenCandidate {
  id: number;
  provider: string;
  accountId: string;
  profileId: string;
  accessToken: string;
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

function mapAccountRow(row: AccountRow): AccountView {
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.account_id,
    profileId: row.profile_id,
    expiresAt: row.expires_at,
    healthScore: row.health_score,
    locked: Boolean(row.locked),
    status: computeAccountStatus({
      locked: row.locked,
      expiresAt: row.expires_at,
      healthScore: row.health_score,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountsService {
  constructor(
    private readonly dbPath: string,
    private readonly tokenVault: TokenVault,
  ) {}

  private async withDatabase<T>(work: (db: sqlite3.Database) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.dbPath);

    try {
      return await work(db);
    } finally {
      await closeDatabase(db);
    }
  }

  async list(options?: { provider?: string; includeRevoked?: boolean }): Promise<AccountView[]> {
    return this.withDatabase(async (db) => {
      const includeRevoked = options?.includeRevoked ?? true;
      const params: unknown[] = [];

      let sql = `
        SELECT id, provider, account_id, profile_id, expires_at, health_score, locked, created_at, updated_at
        FROM accounts
      `;

      const whereParts: string[] = [];

      if (options?.provider) {
        whereParts.push('provider = ?');
        params.push(options.provider);
      }

      if (!includeRevoked) {
        whereParts.push('locked = 0');
      }

      if (whereParts.length) {
        sql += ` WHERE ${whereParts.join(' AND ')}`;
      }

      sql += ' ORDER BY updated_at DESC, id DESC';

      const rows = await getAll<AccountRow>(db, sql, params);
      return rows.map(mapAccountRow);
    });
  }

  async getById(id: number): Promise<AccountView | null> {
    return this.withDatabase(async (db) => {
      const row = await getOne<AccountRow>(
        db,
        `
          SELECT id, provider, account_id, profile_id, expires_at, health_score, locked, created_at, updated_at
          FROM accounts
          WHERE id = ?
        `,
        [id],
      );

      return row ? mapAccountRow(row) : null;
    });
  }

  async create(input: CreateAccountInput): Promise<AccountView> {
    return this.withDatabase(async (db) => {
      const accessTokenEnc = input.accessToken ? this.tokenVault.encrypt(input.accessToken) : null;
      const refreshTokenEnc = input.refreshToken ? this.tokenVault.encrypt(input.refreshToken) : null;

      try {
        const result = await runStatement(
          db,
          `
            INSERT INTO accounts (
              provider,
              account_id,
              profile_id,
              access_token_enc,
              refresh_token_enc,
              expires_at,
              health_score,
              locked,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          `,
          [
            input.provider,
            input.accountId,
            input.profileId,
            accessTokenEnc,
            refreshTokenEnc,
            input.expiresAt || null,
            input.healthScore ?? 100,
            input.locked ? 1 : 0,
          ],
        );

        const created = await getOne<AccountRow>(
          db,
          `
            SELECT id, provider, account_id, profile_id, expires_at, health_score, locked, created_at, updated_at
            FROM accounts
            WHERE id = ?
          `,
          [result.lastID],
        );

        if (!created) {
          throw new Error('Failed to fetch created account');
        }

        return mapAccountRow(created);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('UNIQUE')) {
          throw new Error('Account profile already exists');
        }
        throw error;
      }
    });
  }

  async upsertByProviderAndAccount(
    provider: string,
    accountId: string,
    params: {
      profileId: string;
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: string | null;
      healthScore?: number;
      locked?: boolean;
    }
  ): Promise<AccountView> {
    return this.withDatabase(async (db) => {
      // Buscar cuenta existente
      const existing = await getOne<AccountRow>(
        db,
        `SELECT id FROM accounts WHERE provider = ? AND account_id = ?`,
        [provider, accountId]
      );

      const now = new Date().toISOString();
      const accessTokenEnc = params.accessToken ? this.tokenVault.encrypt(params.accessToken) : null;
      const refreshTokenEnc = params.refreshToken ? this.tokenVault.encrypt(params.refreshToken) : null;

      if (existing) {
        // UPDATE
        await runStatement(
          db,
          `UPDATE accounts SET 
            profile_id = ?,
            access_token_enc = ?,
            refresh_token_enc = ?,
            expires_at = ?,
            health_score = ?,
            locked = ?,
            updated_at = ?
           WHERE id = ?`,
          [
            params.profileId,
            accessTokenEnc,
            refreshTokenEnc,
            params.expiresAt ?? null,
            params.healthScore ?? 100,
            params.locked ? 1 : 0,
            now,
            existing.id
          ]
        );
        const row = await getOne<AccountRow>(db, `SELECT * FROM accounts WHERE id = ?`, [existing.id]);
        return mapAccountRow(row!);
      } else {
        // INSERT
        const result = await runStatement(
          db,
          `INSERT INTO accounts (provider, account_id, profile_id, access_token_enc, refresh_token_enc, expires_at, health_score, locked, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            provider,
            accountId,
            params.profileId,
            accessTokenEnc,
            refreshTokenEnc,
            params.expiresAt ?? null,
            params.healthScore ?? 100,
            params.locked ? 1 : 0,
            now,
            now
          ]
        );
        const row = await getOne<AccountRow>(db, `SELECT * FROM accounts WHERE id = ?`, [result.lastID]);
        return mapAccountRow(row!);
      }
    });
  }

  async revokeById(id: number): Promise<AccountView | null> {
    return this.withDatabase(async (db) => {
      const result = await runStatement(
        db,
        `
          UPDATE accounts
          SET locked = 1,
              updated_at = datetime('now')
          WHERE id = ?
        `,
        [id],
      );

      if (!result.changes) {
        return null;
      }

      const row = await getOne<AccountRow>(
        db,
        `
          SELECT id, provider, account_id, profile_id, expires_at, health_score, locked, created_at, updated_at
          FROM accounts
          WHERE id = ?
        `,
        [id],
      );

      return row ? mapAccountRow(row) : null;
    });
  }

  async listRefreshCandidates(options?: { provider?: string; expiresBefore?: string; limit?: number }): Promise<RefreshCandidate[]> {
    return this.withDatabase(async (db) => {
      const where: string[] = [
        'locked = 0',
        'refresh_token_enc IS NOT NULL',
        "trim(refresh_token_enc) <> ''",
      ];
      const params: unknown[] = [];

      if (options?.provider) {
        where.push('provider = ?');
        params.push(options.provider);
      }

      if (options?.expiresBefore) {
        where.push('(expires_at IS NULL OR expires_at <= ?)');
        params.push(options.expiresBefore);
      }

      let sql = `
        SELECT
          id,
          provider,
          account_id,
          profile_id,
          access_token_enc,
          refresh_token_enc,
          expires_at,
          health_score,
          locked,
          created_at,
          updated_at
        FROM accounts
      `;

      if (where.length) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }

      sql += ' ORDER BY expires_at ASC, id ASC';

      if (options?.limit && Number.isInteger(options.limit) && options.limit > 0) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }

      const rows = await getAll<AccountTokenRow>(db, sql, params);

      return rows
        .filter((row) => typeof row.refresh_token_enc === 'string' && row.refresh_token_enc.length > 0)
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          accountId: row.account_id,
          profileId: row.profile_id,
          refreshToken: this.tokenVault.decrypt(String(row.refresh_token_enc)),
          expiresAt: row.expires_at,
          healthScore: row.health_score,
        }));
    });
  }

  async listAccessTokenCandidates(options?: { provider?: string; includeLocked?: boolean }): Promise<AccessTokenCandidate[]> {
    return this.withDatabase(async (db) => {
      const where: string[] = [
        'access_token_enc IS NOT NULL',
        "trim(access_token_enc) <> ''",
      ];
      const params: unknown[] = [];

      if (!options?.includeLocked) {
        where.push('locked = 0');
      }

      if (options?.provider) {
        where.push('provider = ?');
        params.push(options.provider);
      }

      let sql = `
        SELECT
          id,
          provider,
          account_id,
          profile_id,
          access_token_enc,
          refresh_token_enc,
          expires_at,
          health_score,
          locked,
          created_at,
          updated_at
        FROM accounts
      `;

      if (where.length) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }

      sql += ' ORDER BY updated_at DESC, id DESC';

      const rows = await getAll<AccountTokenRow>(db, sql, params);

      return rows
        .filter((row) => typeof row.access_token_enc === 'string' && row.access_token_enc.length > 0)
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          accountId: row.account_id,
          profileId: row.profile_id,
          accessToken: this.tokenVault.decrypt(String(row.access_token_enc)),
        }));
    });
  }

  async rotateTokensById(id: number, input: RotateTokensInput): Promise<AccountView | null> {
    return this.withDatabase(async (db) => {
      const existing = await getOne<AccountTokenRow>(
        db,
        `
          SELECT
            id,
            provider,
            account_id,
            profile_id,
            access_token_enc,
            refresh_token_enc,
            expires_at,
            health_score,
            locked,
            created_at,
            updated_at
          FROM accounts
          WHERE id = ?
        `,
        [id],
      );

      if (!existing) {
        return null;
      }

      const accessTokenEnc = this.tokenVault.encrypt(input.accessToken);
      const refreshTokenEnc = input.refreshToken
        ? this.tokenVault.encrypt(input.refreshToken)
        : existing.refresh_token_enc;

      const nextExpiresAt = typeof input.expiresAt === 'undefined' ? existing.expires_at : input.expiresAt;
      const nextHealthScore = typeof input.healthScore === 'number' ? input.healthScore : existing.health_score;

      await runStatement(db, 'BEGIN IMMEDIATE TRANSACTION');

      try {
        await runStatement(
          db,
          `
            UPDATE accounts
            SET access_token_enc = ?,
                refresh_token_enc = ?,
                expires_at = ?,
                health_score = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `,
          [
            accessTokenEnc,
            refreshTokenEnc,
            nextExpiresAt,
            nextHealthScore,
            id,
          ],
        );

        const verify = await getOne<AccountTokenRow>(
          db,
          `
            SELECT
              id,
              provider,
              account_id,
              profile_id,
              access_token_enc,
              refresh_token_enc,
              expires_at,
              health_score,
              locked,
              created_at,
              updated_at
            FROM accounts
            WHERE id = ?
          `,
          [id],
        );

        if (!verify || typeof verify.access_token_enc !== 'string' || !verify.access_token_enc.length) {
          throw new Error('Token rotate verification failed: access token was not persisted');
        }

        const persistedAccessToken = this.tokenVault.decrypt(String(verify.access_token_enc));
        if (persistedAccessToken !== input.accessToken) {
          throw new Error('Token rotate verification failed: access token mismatch after write');
        }

        if (typeof input.refreshToken === 'string') {
          if (typeof verify.refresh_token_enc !== 'string' || !verify.refresh_token_enc.length) {
            throw new Error('Token rotate verification failed: refresh token was not persisted');
          }

          const persistedRefreshToken = this.tokenVault.decrypt(String(verify.refresh_token_enc));
          if (persistedRefreshToken !== input.refreshToken) {
            throw new Error('Token rotate verification failed: refresh token mismatch after write');
          }
        }

        if (typeof input.expiresAt !== 'undefined') {
          const persistedExpiresAt = verify.expires_at ?? null;
          const expectedExpiresAt = input.expiresAt ?? null;
          if (persistedExpiresAt !== expectedExpiresAt) {
            throw new Error('Token rotate verification failed: expires_at mismatch after write');
          }
        }

        await runStatement(db, 'COMMIT');

        return mapAccountRow(verify);
      } catch (error) {
        try {
          await runStatement(db, 'ROLLBACK');
        } catch {
          // ignore rollback secondary failures
        }
        throw error;
      }
    });
  }

  async updateHealthScoreById(id: number, healthScore: number): Promise<AccountView | null> {
    return this.withDatabase(async (db) => {
      const result = await runStatement(
        db,
        `
          UPDATE accounts
          SET health_score = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `,
        [healthScore, id],
      );

      if (!result.changes) {
        return null;
      }

      const updated = await getOne<AccountRow>(
        db,
        `
          SELECT id, provider, account_id, profile_id, expires_at, health_score, locked, created_at, updated_at
          FROM accounts
          WHERE id = ?
        `,
        [id],
      );

      return updated ? mapAccountRow(updated) : null;
    });
  }

  async statusById(id: number): Promise<{ id: number; status: AccountStatus; locked: boolean; expiresAt: string | null; healthScore: number } | null> {
    const account = await this.getById(id);

    if (!account) {
      return null;
    }

    return {
      id: account.id,
      status: account.status,
      locked: account.locked,
      expiresAt: account.expiresAt,
      healthScore: account.healthScore,
    };
  }
}

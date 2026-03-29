import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accountsService';
import { TokenVault } from '../src/tokenVault';

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

describe('AccountsService', () => {
  let tempDir: string;
  let dbPath: string;
  let service: AccountsService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-accounts-'));
    dbPath = path.join(tempDir, 'ocom.db');
    await initializeAccountsTable(dbPath);

    service = new AccountsService(dbPath, new TokenVault('unit-test-master-key'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and lists accounts with computed status', async () => {
    const created = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-1',
      profileId: 'openai-codex:default',
      healthScore: 99,
    });

    expect(created.status).toBe('active');

    const list = await service.list({ provider: 'openai-codex' });

    expect(list).toHaveLength(1);
    expect(list[0].accountId).toBe('acct-1');
    expect(list[0].profileId).toBe('openai-codex:default');
    expect(list[0].locked).toBe(false);
  });

  it('revokeById sets account status to revoked', async () => {
    const created = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-2',
      profileId: 'openai-codex:profile2',
    });

    const revoked = await service.revokeById(created.id);

    expect(revoked).not.toBeNull();
    expect(revoked?.locked).toBe(true);
    expect(revoked?.status).toBe('revoked');
  });

  it('statusById reflects degraded/failover thresholds', async () => {
    const degraded = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-3',
      profileId: 'openai-codex:profile3',
      healthScore: 40,
    });

    const failover = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-4',
      profileId: 'openai-codex:profile4',
      healthScore: 20,
    });

    const degradedStatus = await service.statusById(degraded.id);
    const failoverStatus = await service.statusById(failover.id);

    expect(degradedStatus?.status).toBe('degraded');
    expect(failoverStatus?.status).toBe('failover');
  });

  it('filters revoked accounts when includeRevoked=false', async () => {
    const active = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-5',
      profileId: 'openai-codex:profile5',
    });

    const revoked = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-6',
      profileId: 'openai-codex:profile6',
    });

    await service.revokeById(revoked.id);

    const filtered = await service.list({ provider: 'openai-codex', includeRevoked: false });

    expect(filtered.map((item) => item.id)).toEqual([active.id]);
  });

  it('lists refresh candidates and rotates tokens', async () => {
    const soonExpiring = new Date(Date.now() + 5 * 60_000).toISOString();
    const laterExpiring = new Date(Date.now() + 120 * 60_000).toISOString();

    const target = await service.create({
      provider: 'openai-codex',
      accountId: 'acct-refresh-target',
      profileId: 'openai-codex:refresh-target',
      refreshToken: 'refresh-old-token',
      accessToken: 'access-old-token',
      expiresAt: soonExpiring,
    });

    await service.create({
      provider: 'openai-codex',
      accountId: 'acct-refresh-later',
      profileId: 'openai-codex:refresh-later',
      refreshToken: 'refresh-later-token',
      accessToken: 'access-later-token',
      expiresAt: laterExpiring,
    });

    const candidates = await service.listRefreshCandidates({
      provider: 'openai-codex',
      expiresBefore: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(target.id);
    expect(candidates[0].refreshToken).toBe('refresh-old-token');

    const rotated = await service.rotateTokensById(target.id, {
      accessToken: 'access-new-token',
      refreshToken: 'refresh-new-token',
      expiresAt: new Date(Date.now() + 180 * 60_000).toISOString(),
    });

    expect(rotated).not.toBeNull();

    const afterRotate = await service.listRefreshCandidates({
      provider: 'openai-codex',
      expiresBefore: new Date(Date.now() + 200 * 60_000).toISOString(),
    });

    const rotatedCandidate = afterRotate.find((item) => item.id === target.id);
    expect(rotatedCandidate?.refreshToken).toBe('refresh-new-token');

    const accessCandidates = await service.listAccessTokenCandidates({
      provider: 'openai-codex',
      includeLocked: true,
    });

    const rotatedAccess = accessCandidates.find((item) => item.id === target.id);
    expect(rotatedAccess?.accessToken).toBe('access-new-token');

    const status = await service.getById(target.id);
    expect(status?.expiresAt).not.toBe(soonExpiring);
  });
});

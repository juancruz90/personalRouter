import { AccountView, AccountsService } from './accountsService';
import { computeAccountStatus } from './accountStatus';

export interface HealthRunOptions {
  provider?: string;
  limit?: number;
}

export interface HealthRunItem {
  accountId: number;
  provider: string;
  profileId: string;
  previousScore: number;
  nextScore: number;
  status: string;
  changed: boolean;
  reason: string;
}

export interface HealthRunResult {
  ok: boolean;
  scanned: number;
  updated: number;
  active: number;
  degraded: number;
  failover: number;
  expired: number;
  revoked: number;
  results: HealthRunItem[];
}

export function computeHealthScore(account: Pick<AccountView, 'locked' | 'expiresAt'>, nowMs = Date.now()): { score: number; reason: string } {
  if (account.locked) {
    return { score: 0, reason: 'locked' };
  }

  if (!account.expiresAt) {
    return { score: 60, reason: 'missing_expiry' };
  }

  const expiresMs = Date.parse(account.expiresAt);
  if (Number.isNaN(expiresMs)) {
    return { score: 30, reason: 'invalid_expiry' };
  }

  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    return { score: 0, reason: 'expired' };
  }

  const minute = 60_000;
  const hour = 60 * minute;

  if (remainingMs <= 5 * minute) {
    return { score: 10, reason: '<=5m' };
  }

  if (remainingMs <= 15 * minute) {
    return { score: 20, reason: '<=15m' };
  }

  if (remainingMs <= 60 * minute) {
    return { score: 40, reason: '<=60m' };
  }

  if (remainingMs <= 6 * hour) {
    return { score: 60, reason: '<=6h' };
  }

  if (remainingMs <= 24 * hour) {
    return { score: 80, reason: '<=24h' };
  }

  return { score: 100, reason: '>24h' };
}

export class HealthService {
  constructor(private readonly accounts: AccountsService) {}

  async runOnce(options?: HealthRunOptions): Promise<HealthRunResult> {
    const source = await this.accounts.list({
      provider: options?.provider,
      includeRevoked: true,
    });

    const items = typeof options?.limit === 'number' && options.limit > 0
      ? source.slice(0, options.limit)
      : source;

    const results: HealthRunItem[] = [];
    let updated = 0;
    let active = 0;
    let degraded = 0;
    let failover = 0;
    let expired = 0;
    let revoked = 0;

    for (const account of items) {
      const next = computeHealthScore(account);
      const changed = account.healthScore !== next.score;

      if (changed) {
        await this.accounts.updateHealthScoreById(account.id, next.score);
        updated += 1;
      }

      const status = computeAccountStatus({
        locked: account.locked,
        expiresAt: account.expiresAt,
        healthScore: next.score,
      });

      if (status === 'active') active += 1;
      if (status === 'degraded') degraded += 1;
      if (status === 'failover') failover += 1;
      if (status === 'expired') expired += 1;
      if (status === 'revoked') revoked += 1;

      results.push({
        accountId: account.id,
        provider: account.provider,
        profileId: account.profileId,
        previousScore: account.healthScore,
        nextScore: next.score,
        status,
        changed,
        reason: next.reason,
      });
    }

    return {
      ok: true,
      scanned: items.length,
      updated,
      active,
      degraded,
      failover,
      expired,
      revoked,
      results,
    };
  }
}

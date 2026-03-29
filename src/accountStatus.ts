export type AccountStatus = 'active' | 'degraded' | 'failover' | 'expired' | 'revoked';

export interface AccountStatusInput {
  locked: boolean | number;
  expiresAt?: string | null;
  healthScore: number;
  nowMs?: number;
}

export function computeAccountStatus(input: AccountStatusInput): AccountStatus {
  const nowMs = input.nowMs ?? Date.now();
  const locked = typeof input.locked === 'number' ? input.locked !== 0 : input.locked;

  if (locked) {
    return 'revoked';
  }

  if (input.expiresAt) {
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isNaN(expiry) && expiry <= nowMs) {
      return 'expired';
    }
  }

  if (input.healthScore <= 20) {
    return 'failover';
  }

  if (input.healthScore <= 50) {
    return 'degraded';
  }

  return 'active';
}

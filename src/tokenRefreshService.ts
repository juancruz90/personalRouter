import { AccountsService } from './accountsService';
import { providerConfigFromEnv } from './oauthPkce';

export interface TokenRefreshRunOptions {
  provider?: string;
  expiresInMinutes?: number;
  limit?: number;
}

export interface TokenRefreshItemResult {
  accountId: number;
  provider: string;
  profileId: string;
  refreshed: boolean;
  error?: string;
}

export interface TokenRefreshRunResult {
  ok: boolean;
  scanned: number;
  refreshed: number;
  failed: number;
  expiresBefore: string;
  results: TokenRefreshItemResult[];
}

export class TokenRefreshService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async runOnce(options?: TokenRefreshRunOptions): Promise<TokenRefreshRunResult> {
    const expiresInMinutes = Number.isFinite(options?.expiresInMinutes)
      ? Math.max(0, Number(options?.expiresInMinutes))
      : 15;

    const expiresBefore = new Date(Date.now() + (expiresInMinutes * 60_000)).toISOString();

    const candidates = await this.accounts.listRefreshCandidates({
      provider: options?.provider,
      expiresBefore,
      limit: options?.limit,
    });

    const results: TokenRefreshItemResult[] = [];

    for (const candidate of candidates) {
      try {
        const cfg = providerConfigFromEnv(candidate.provider);
        if (!cfg.tokenUrl) {
          throw new Error(`Token endpoint not configured for provider ${candidate.provider}`);
        }

        const payload = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: candidate.refreshToken,
          client_id: cfg.clientId,
        });

        if (cfg.clientSecret) {
          payload.set('client_secret', cfg.clientSecret);
        }

        const response = await this.fetchFn(cfg.tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: payload.toString(),
        });

        const raw = await response.text();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = null;
        }

        if (!response.ok) {
          const detail = parsed && (parsed.error_description || parsed.error);
          throw new Error(`Token refresh failed (${response.status})${detail ? `: ${detail}` : ''}`);
        }

        const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token : undefined;
        if (!accessToken) {
          throw new Error('Token refresh response missing access_token');
        }

        const refreshToken = typeof parsed?.refresh_token === 'string' ? parsed.refresh_token : undefined;
        const expiresIn = typeof parsed?.expires_in === 'number' ? parsed.expires_in : undefined;
        const expiresAt = typeof expiresIn === 'number'
          ? new Date(Date.now() + (expiresIn * 1000)).toISOString()
          : undefined;

        await this.accounts.rotateTokensById(candidate.id, {
          accessToken,
          refreshToken,
          expiresAt,
        });

        results.push({
          accountId: candidate.id,
          provider: candidate.provider,
          profileId: candidate.profileId,
          refreshed: true,
        });
      } catch (error) {
        results.push({
          accountId: candidate.id,
          provider: candidate.provider,
          profileId: candidate.profileId,
          refreshed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const refreshed = results.filter((item) => item.refreshed).length;
    const failed = results.length - refreshed;

    return {
      ok: failed === 0,
      scanned: candidates.length,
      refreshed,
      failed,
      expiresBefore,
      results,
    };
  }
}

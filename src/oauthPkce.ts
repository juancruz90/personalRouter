import crypto from 'crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function toBase64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256Base64Url(value: string): string {
  return toBase64Url(crypto.createHash('sha256').update(value).digest());
}

function randomBase64Url(bytes = 32): string {
  return toBase64Url(crypto.randomBytes(bytes));
}

function providerKey(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function splitScopes(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function envValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export interface OAuthProviderConfig {
  provider: string;
  clientId: string;
  authorizationUrl: string;
  redirectUri: string;
  tokenUrl?: string;
  clientSecret?: string;
  scopes: string[];
  audience?: string;
}

export interface PkceStorageHint {
  accountId?: string;
  profileId?: string;
  healthScore?: number;
  store?: boolean;
}

export interface PkceSession {
  provider: string;
  state: string;
  codeVerifier: string;
  createdAt: number;
  expiresAt: number;
  storageHint?: PkceStorageHint;
}

export interface PkceStartResult {
  provider: string;
  state: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface PkceCompleteResult {
  provider: string;
  state: string;
  tokenExchanged: boolean;
  receivedCode: boolean;
  tokenMeta?: {
    tokenType?: string;
    expiresIn?: number;
    scope?: string;
  };
  tokens?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
  };
  storageHint?: PkceStorageHint;
}

export class PkceSessionStore {
  private readonly sessions = new Map<string, PkceSession>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now = () => Date.now(),
  ) {}

  create(provider: string, codeVerifier: string, storageHint?: PkceStorageHint): PkceSession {
    const now = this.now();
    const state = randomBase64Url(24);

    const session: PkceSession = {
      provider,
      state,
      codeVerifier,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      storageHint,
    };

    this.sessions.set(state, session);
    return session;
  }

  consume(provider: string, state: string): PkceSession {
    const session = this.sessions.get(state);
    this.sessions.delete(state);

    if (!session || session.provider !== provider) {
      throw new Error('Invalid oauth state');
    }

    if (session.expiresAt < this.now()) {
      throw new Error('Expired oauth state');
    }

    return session;
  }
}

export function providerConfigFromEnv(provider: string): OAuthProviderConfig {
  const key = providerKey(provider);

  const clientId = envValue([
    `OAUTH_${key}_CLIENT_ID`,
    'OAUTH_CLIENT_ID',
  ]);
  const authorizationUrl = envValue([
    `OAUTH_${key}_AUTH_URL`,
    'OAUTH_AUTH_URL',
  ]);
  const redirectUri = envValue([
    `OAUTH_${key}_REDIRECT_URI`,
    'OAUTH_REDIRECT_URI',
  ]);

  if (!clientId || !authorizationUrl || !redirectUri) {
    throw new Error(
      `Missing oauth config for ${provider}. Required: OAUTH_${key}_CLIENT_ID, OAUTH_${key}_AUTH_URL, OAUTH_${key}_REDIRECT_URI`,
    );
  }

  const tokenUrl = envValue([
    `OAUTH_${key}_TOKEN_URL`,
    'OAUTH_TOKEN_URL',
  ]);
  const clientSecret = envValue([
    `OAUTH_${key}_CLIENT_SECRET`,
    'OAUTH_CLIENT_SECRET',
  ]);

  const scopeRaw = envValue([
    `OAUTH_${key}_SCOPES`,
    `OAUTH_${key}_SCOPE`,
    'OAUTH_SCOPES',
    'OAUTH_SCOPE',
  ]);

  const audience = envValue([
    `OAUTH_${key}_AUDIENCE`,
    'OAUTH_AUDIENCE',
  ]);

  return {
    provider,
    clientId,
    authorizationUrl,
    redirectUri,
    tokenUrl,
    clientSecret,
    scopes: splitScopes(scopeRaw),
    audience,
  };
}

export class OAuthPkceService {
  constructor(
    private readonly getProviderConfig: (provider: string) => OAuthProviderConfig = providerConfigFromEnv,
    private readonly sessions = new PkceSessionStore(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  start(provider: string, customScopes?: string[], storageHint?: PkceStorageHint): PkceStartResult {
    const cfg = this.getProviderConfig(provider);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const session = this.sessions.create(provider, codeVerifier, storageHint);

    const scopes = customScopes && customScopes.length ? customScopes : cfg.scopes;

    const authUrl = new URL(cfg.authorizationUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', cfg.clientId);
    authUrl.searchParams.set('redirect_uri', cfg.redirectUri);
    authUrl.searchParams.set('state', session.state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Force re-authentication to avoid invalid_grant due to silent SSO reuse
    authUrl.searchParams.set('prompt', 'login');

    if (scopes.length) {
      authUrl.searchParams.set('scope', scopes.join(' '));
    }

    if (cfg.audience) {
      authUrl.searchParams.set('audience', cfg.audience);
    }

    // Force re-approval to avoid invalid_grant due to stale consent
    if (provider === 'openai-codex' || provider.includes('openai') || provider.includes('codex')) {
      authUrl.searchParams.set('approval_prompt', 'force');
    } else {
      authUrl.searchParams.set('prompt', 'login');
    }

    return {
      provider,
      state: session.state,
      authorizationUrl: authUrl.toString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async complete(provider: string, state: string, code: string): Promise<PkceCompleteResult> {
    if (!code) {
      throw new Error('Missing oauth authorization code');
    }

    const cfg = this.getProviderConfig(provider);
    const session = this.sessions.consume(provider, state);

    if (!cfg.tokenUrl) {
      return {
        provider,
        state,
        tokenExchanged: false,
        receivedCode: true,
        storageHint: session.storageHint,
      };
    }

    const payload = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      code_verifier: session.codeVerifier,
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
      throw new Error(`Token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const expiresIn = typeof parsed?.expires_in === 'number' ? parsed.expires_in : undefined;
    const expiresAt = typeof expiresIn === 'number'
      ? new Date(Date.now() + (expiresIn * 1000)).toISOString()
      : undefined;

    return {
      provider,
      state,
      tokenExchanged: true,
      receivedCode: true,
      tokenMeta: {
        tokenType: typeof parsed?.token_type === 'string' ? parsed.token_type : undefined,
        expiresIn,
        scope: typeof parsed?.scope === 'string' ? parsed.scope : undefined,
      },
      tokens: {
        accessToken: typeof parsed?.access_token === 'string' ? parsed.access_token : undefined,
        refreshToken: typeof parsed?.refresh_token === 'string' ? parsed.refresh_token : undefined,
        expiresAt,
      },
      storageHint: session.storageHint,
    };
  }
}

import { describe, expect, it } from 'vitest';
import {
  OAuthPkceService,
  OAuthProviderConfig,
  PkceSessionStore,
} from '../src/oauthPkce';

function baseConfig(overrides?: Partial<OAuthProviderConfig>): OAuthProviderConfig {
  return {
    provider: 'openai-codex',
    clientId: 'test-client-id',
    authorizationUrl: 'https://auth.example.com/authorize',
    redirectUri: 'http://127.0.0.1:3001/oauth/openai-codex/callback',
    scopes: ['openid', 'profile'],
    ...overrides,
  };
}

describe('OAuthPkceService', () => {
  it('builds authorization url with PKCE params', () => {
    const service = new OAuthPkceService(() => baseConfig());

    const result = service.start('openai-codex');
    const url = new URL(result.authorizationUrl);

    expect(result.provider).toBe('openai-codex');
    expect(result.state.length).toBeGreaterThan(20);
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('scope')).toBe('openid profile');
  });

  it('rejects callback with invalid state', async () => {
    const service = new OAuthPkceService(() => baseConfig());

    await expect(service.complete('openai-codex', 'bad-state', 'auth-code')).rejects.toThrow('Invalid oauth state');
  });

  it('rejects callback with expired state', async () => {
    let now = 0;
    const store = new PkceSessionStore(1000, () => now);
    const service = new OAuthPkceService(() => baseConfig(), store);

    const start = service.start('openai-codex');
    now = 2000;

    await expect(service.complete('openai-codex', start.state, 'auth-code')).rejects.toThrow('Expired oauth state');
  });

  it('exchanges token when token endpoint is configured', async () => {
    const calls: Array<{ url: string; body: string }> = [];

    const service = new OAuthPkceService(
      () => baseConfig({ tokenUrl: 'https://auth.example.com/token', clientSecret: 'secret' }),
      new PkceSessionStore(),
      async (url, init) => {
        calls.push({
          url: String(url),
          body: String(init?.body || ''),
        });

        return new Response(
          JSON.stringify({
            access_token: 'secret-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );

    const start = service.start('openai-codex');
    const result = await service.complete('openai-codex', start.state, 'auth-code');

    expect(result.tokenExchanged).toBe(true);
    expect(result.tokenMeta).toEqual({
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'openid profile',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://auth.example.com/token');
    expect(calls[0].body).toContain('grant_type=authorization_code');
    expect(calls[0].body).toContain('code=auth-code');
    expect(calls[0].body).toContain('code_verifier=');
  });
});

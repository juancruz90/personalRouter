import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

describe('server openapi route', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it('serves OpenAPI v1 contract as single source of truth', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/openapi.json',
      headers: {
        host: 'localhost:3001',
      },
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json();
    expect(payload.openapi).toBe('3.1.0');
    expect(payload.info?.version).toBe('1.0.0');

    const paths = payload.paths as Record<string, unknown>;
    expect(paths['/accounts']).toBeDefined();
    expect(paths['/assignments']).toBeDefined();
    expect(paths['/router/{agentSlug}/select']).toBeDefined();
    expect(paths['/seed/personal-provider']).toBeDefined();
    expect(paths['/backup/run']).toBeDefined();
  });
});

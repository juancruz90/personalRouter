import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

describe('server project lock hook', () => {
  it('blocks mutating writes for locked reel project', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/projects/reel/simulate-write',
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'project_locked',
      project: 'reel',
      mode: 'read-only',
    });
  });

  it('allows mutating writes for non-locked projects', async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/projects/personal-provider/simulate-write',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      project: 'personal-provider',
      action: 'write_allowed',
    });
  });
});

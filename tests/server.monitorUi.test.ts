import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

describe('server monitor ui', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it('serves monitoring board html', async () => {
    const server = createServer();
    servers.push(server);

    const landing = await server.inject({
      method: 'GET',
      url: '/',
    });

    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain('OCOM');
    expect(landing.body).toContain('/ui/oauth-wizard');

    const response = await server.inject({
      method: 'GET',
      url: '/ui/monitor',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('OCOM Monitoring Board');
    expect(response.body).toContain('/ws/events');
    expect(response.body).toContain('/events/recent');

    const boardHtml = await server.inject({
      method: 'GET',
      url: '/board.html',
    });

    expect(boardHtml.statusCode).toBe(200);
    expect(boardHtml.body).toContain('OCOM Monitoring Board');

    const accountsUi = await server.inject({
      method: 'GET',
      url: '/ui/accounts',
    });

    expect(accountsUi.statusCode).toBe(200);
    expect(accountsUi.body).toContain('Accounts & Runtime Status');
    expect(accountsUi.body).toContain('/accounts/runtime');

    const accountsHtml = await server.inject({
      method: 'GET',
      url: '/accounts.html',
    });

    expect(accountsHtml.statusCode).toBe(200);
    expect(accountsHtml.body).toContain('Accounts & Runtime Status');
  });
});

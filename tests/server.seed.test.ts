import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const ENV_KEYS = [
  'DATABASE_PATH',
  'TOKEN_VAULT_MASTER_KEY',
  'TOKEN_REFRESH_INTERVAL_MS',
  'HEALTH_CHECK_INTERVAL_MINUTES',
  'BACKUP_INTERVAL_HOURS',
] as const;

describe('server seed route', () => {
  let tempDir: string;
  const servers: Array<ReturnType<typeof createServer>> = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-server-seed-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'ocom.db');
    process.env.TOKEN_VAULT_MASTER_KEY = 'server-seed-master-key';
    process.env.TOKEN_REFRESH_INTERVAL_MS = '0';
    process.env.HEALTH_CHECK_INTERVAL_MINUTES = '0';
    process.env.BACKUP_INTERVAL_HOURS = '0';
  });

  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }

    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds personal-provider and emits event', async () => {
    const server = createServer();
    servers.push(server);

    const first = await server.inject({
      method: 'POST',
      url: '/seed/personal-provider',
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().project.name).toBe('personal-provider');
    expect(first.json().agents.length).toBe(5);

    const second = await server.inject({
      method: 'POST',
      url: '/seed/personal-provider',
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().agents.length).toBe(5);

    const events = await server.inject({
      method: 'GET',
      url: '/events/recent?limit=10',
    });

    expect(events.statusCode).toBe(200);
    const payload = events.json();
    expect(payload.events.some((event: { type: string }) => event.type === 'seed.personal_provider')).toBe(true);
  });
});

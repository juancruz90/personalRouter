import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeedService } from '../src/seedService';

describe('SeedService', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-seed-'));
    dbPath = path.join(tempDir, 'ocom.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds personal-provider project and base agents idempotently', async () => {
    const service = new SeedService(dbPath);

    const first = await service.seedPersonalProvider();
    const second = await service.seedPersonalProvider();

    expect(first.project.name).toBe('personal-provider');
    expect(first.agents.length).toBe(5);
    expect(second.agents.length).toBe(5);
    expect(second.agents.map((agent) => agent.slug)).toEqual([
      'condor',
      'florencia',
      'lince',
      'puma',
      'yaguarete',
    ]);
  });
});

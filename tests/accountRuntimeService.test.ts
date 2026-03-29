import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountRuntimeService } from '../src/accountRuntimeService';

describe('AccountRuntimeService', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocom-runtime-'));
    dbPath = path.join(tempDir, 'ocom.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records runtime outcomes and auto-recovers exhausted accounts after reset window', async () => {
    const service = new AccountRuntimeService(dbPath, 1);

    const exhausted = await service.recordEvent({
      accountId: 7,
      outcome: 'exhausted',
      errorCode: 'quota_exceeded',
      errorMessage: 'limit reached',
    });

    expect(exhausted.state).toBe('exhausted');
    expect(exhausted.exhaustedUntil).not.toBeNull();

    const recovered = await service.recoverDue(new Date(Date.now() + 2 * 60 * 60_000));
    expect(recovered.some((item) => item.accountId === 7)).toBe(true);

    const byId = await service.listByAccountId([7]);
    expect(byId[7].state).toBe('degraded');

    const success = await service.recordEvent({
      accountId: 7,
      outcome: 'success',
    });

    expect(success.state).toBe('healthy');
  });
});

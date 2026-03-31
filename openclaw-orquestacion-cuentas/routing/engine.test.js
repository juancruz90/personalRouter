const test = require('node:test');
const assert = require('node:assert/strict');
const { getEligibleAccounts } = require('./engine');

test('getEligibleAccounts filters and orders by backoff_level', () => {
  const rows = [
    { id: '1', status: 'healthy', cooldown_until: null, backoff_level: 2, updated_at: '2026-01-01T00:00:00.000Z' },
    { id: '2', status: 'auth_error', cooldown_until: null, backoff_level: 0, updated_at: '2026-01-01T00:00:00.000Z' },
    { id: '3', status: 'healthy', cooldown_until: '2999-01-01T00:00:00.000Z', backoff_level: 0, updated_at: '2026-01-01T00:00:00.000Z' },
    { id: '4', status: 'healthy', cooldown_until: null, backoff_level: 1, updated_at: '2026-01-01T00:00:00.000Z' }
  ];

  const fakeDb = {
    prepare() {
      return {
        all(nowIso) {
          return rows
            .filter((row) => row.status === 'healthy')
            .filter((row) => !row.cooldown_until || row.cooldown_until < nowIso)
            .filter((row) => row.status !== 'auth_error')
            .filter((row) => row.status !== 'quota_exceeded')
            .sort((a, b) => a.backoff_level - b.backoff_level || a.updated_at.localeCompare(b.updated_at));
        },
      };
    },
  };

  const result = getEligibleAccounts(fakeDb, '2026-03-30T00:00:00.000Z');
  assert.deepEqual(result.map((row) => row.id), ['4', '1']);
});

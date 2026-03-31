const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRefresh } = require('./refresh');

test('shouldRefresh returns true when token expires in less than five minutes', () => {
  const expiresAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
  assert.equal(shouldRefresh(expiresAt), true);
});

test('shouldRefresh returns false when token has more than five minutes left', () => {
  const expiresAt = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  assert.equal(shouldRefresh(expiresAt), false);
});

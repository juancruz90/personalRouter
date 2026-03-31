const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBackoffDelay } = require('./manager');

test('backoff level 0 uses base delay', () => {
  assert.equal(calculateBackoffDelay(5000, 0, 6), 5000);
});

test('backoff level 1 doubles base delay', () => {
  assert.equal(calculateBackoffDelay(5000, 1, 6), 10000);
});

test('backoff level 2 quadruples base delay', () => {
  assert.equal(calculateBackoffDelay(5000, 2, 6), 20000);
});

test('backoff level 3 is eight times base delay', () => {
  assert.equal(calculateBackoffDelay(5000, 3, 6), 40000);
});

test('backoff level 6 respects max level', () => {
  assert.equal(calculateBackoffDelay(5000, 6, 6), 320000);
});

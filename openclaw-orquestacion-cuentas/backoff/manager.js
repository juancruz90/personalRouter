const { createDb } = require('../db');

function calculateBackoffDelay(baseDelayMs, level, maxLevel) {
  const safeLevel = Math.min(level, maxLevel);
  return baseDelayMs * (2 ** safeLevel);
}

function markExhausted(accountId, { baseDelayMs = 5000, maxLevel = 6, currentLevel = 0 } = {}) {
  const now = Date.now();
  const delayMs = calculateBackoffDelay(baseDelayMs, currentLevel, maxLevel);
  const nextLevel = currentLevel >= maxLevel ? maxLevel : currentLevel + 1;
  const cooldownUntil = new Date(now + delayMs).toISOString();
  const db = createDb();

  db.prepare(`
    UPDATE accounts
    SET status = 'exhausted',
        cooldown_until = ?,
        backoff_until = ?,
        backoff_level = ?,
        updated_at = ?
    WHERE id = ?
  `).run(cooldownUntil, cooldownUntil, nextLevel, new Date(now).toISOString(), accountId);

  db.close();

  return {
    delayMs,
    cooldownUntil,
    nextLevel,
  };
}

module.exports = {
  calculateBackoffDelay,
  markExhausted,
};

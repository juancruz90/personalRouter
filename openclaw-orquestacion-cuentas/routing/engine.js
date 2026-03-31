const { createDb } = require('../db');
const { maskEmail } = require('../auth/oauth-store');

function getEligibleAccounts(db, nowIso) {
  return db.prepare(`
    SELECT *
    FROM accounts
    WHERE status = 'healthy'
      AND (cooldown_until IS NULL OR cooldown_until < ?)
      AND status != 'auth_error'
      AND status != 'quota_exceeded'
    ORDER BY backoff_level ASC, updated_at ASC
  `).all(nowIso);
}

async function routeRequest(request) {
  const db = createDb();
  const nowIso = new Date().toISOString();
  const accounts = getEligibleAccounts(db, nowIso);
  db.close();

  if (!accounts.length) {
    return {
      selectedAccount: null,
      request,
      reason: 'no_eligible_accounts',
    };
  }

  const selectedAccount = accounts[0];
  console.log(JSON.stringify({
    module: 'routing',
    level: 'info',
    message: 'account_selected',
    email: maskEmail(selectedAccount.email),
    backoff_level: selectedAccount.backoff_level,
    reason: 'lowest_backoff_level',
    timestamp: nowIso,
  }));

  return {
    selectedAccount,
    request,
    reason: 'lowest_backoff_level',
  };
}

module.exports = {
  routeRequest,
  getEligibleAccounts,
};

const { createDb } = require('../db');

function shouldRefresh(expiresAt, now = Date.now()) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - now < 5 * 60 * 1000;
}

function markAuthError(accountId) {
  const db = createDb();
  db.prepare(`
    UPDATE accounts
    SET status = 'auth_error', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), accountId);
  db.close();
}

function updateTokens(accountId, accessToken, expiresAt) {
  const db = createDb();
  db.prepare(`
    UPDATE accounts
    SET access_token = ?, expires_at = ?, updated_at = ?, status = 'healthy'
    WHERE id = ?
  `).run(accessToken, expiresAt, new Date().toISOString(), accountId);
  db.close();
}

async function refreshAccountToken(account, tokenProvider) {
  if (!shouldRefresh(account.expires_at)) {
    return { refreshed: false, account };
  }

  try {
    const refreshed = await tokenProvider(account);
    updateTokens(account.id, refreshed.access_token, refreshed.expires_at);
    return {
      refreshed: true,
      account: {
        ...account,
        access_token: refreshed.access_token,
        expires_at: refreshed.expires_at,
        status: 'healthy',
      },
    };
  } catch (error) {
    markAuthError(account.id);
    return {
      refreshed: false,
      failed: true,
      error: error.message,
      account: {
        ...account,
        status: 'auth_error',
      },
    };
  }
}

module.exports = {
  shouldRefresh,
  refreshAccountToken,
  markAuthError,
  updateTokens,
};

const { randomUUID } = require('crypto');
const { createDb } = require('../db');

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_error) {
    return null;
  }
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return 'unknown';
  return `${local.slice(0, 3)}***@${domain}`;
}

function upsertAccount({ email, provider, accessToken, refreshToken, expiresAt }) {
  const db = createDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare('SELECT id FROM accounts WHERE email = ? AND provider = ?')
    .get(email, provider);

  if (existing) {
    db.prepare(`
      UPDATE accounts
      SET access_token = ?, refresh_token = ?, expires_at = ?, status = 'healthy', updated_at = ?
      WHERE id = ?
    `).run(accessToken, refreshToken, expiresAt, now, existing.id);

    console.log(`Cuenta actualizada: ${maskEmail(email)}`);
    db.close();
    return { id: existing.id, action: 'updated' };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, status, access_token, refresh_token, expires_at,
      cooldown_until, backoff_until, backoff_level, score, created_at, updated_at
    ) VALUES (?, ?, ?, 'healthy', ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
  `).run(id, email, provider, accessToken, refreshToken, expiresAt, now, now);

  console.log(`Cuenta nueva capturada: ${maskEmail(email)}`);
  db.close();
  return { id, action: 'created' };
}

function extractEmail({ accessToken, userInfo }) {
  const payload = decodeJwtPayload(accessToken || '');
  return userInfo?.email || payload?.email || payload?.sub || null;
}

module.exports = {
  decodeJwtPayload,
  extractEmail,
  upsertAccount,
  maskEmail,
};

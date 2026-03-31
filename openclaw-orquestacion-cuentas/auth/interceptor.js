const express = require('express');
const { extractEmail, upsertAccount } = require('./oauth-store');

function createAuthRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.post('/oauth/callback/:provider', async (req, res) => {
    const provider = req.params.provider;
    const code = req.body.code || req.query.code;
    const tokenResponse = req.body.token_response || {};
    const accessToken = tokenResponse.access_token;
    const refreshToken = tokenResponse.refresh_token || 'pending-encryption';
    const expiresIn = Number(tokenResponse.expires_in || 3600);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const email = extractEmail({ accessToken, userInfo: req.body.userinfo });

    if (!code) {
      return res.status(400).json({ error: 'Missing OAuth authorization code' });
    }

    if (!accessToken) {
      return res.status(400).json({ error: 'Missing access_token in token_response' });
    }

    if (!email) {
      return res.status(400).json({ error: 'Could not extract email from token or userinfo' });
    }

    const result = upsertAccount({
      email,
      provider,
      accessToken,
      refreshToken,
      expiresAt,
    });

    return res.status(200).json({
      provider,
      email,
      account: result,
    });
  });

  return router;
}

module.exports = {
  createAuthRouter,
};

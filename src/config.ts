export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  env: process.env.NODE_ENV || 'development',
  tokenVault: {
    masterKey: process.env.TOKEN_VAULT_MASTER_KEY || process.env.MASTER_KEY || 'changeme-please-generate-strong-key',
  },
  database: {
    path: process.env.DATABASE_PATH || './data/ocom.db',
  },
  health: {
    checkIntervalMinutes: parseInt(process.env.HEALTH_CHECK_INTERVAL_MINUTES || '5', 10),
    scoreThresholdDegraded: parseInt(process.env.HEALTH_SCORE_THRESHOLD_DEGRADED || '50', 10),
    scoreThresholdFailover: parseInt(process.env.HEALTH_SCORE_THRESHOLD_FAILOVER || '20', 10),
  },
};

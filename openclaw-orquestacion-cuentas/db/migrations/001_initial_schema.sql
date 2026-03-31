PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  cooldown_until TEXT,
  backoff_until TEXT,
  backoff_level INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(email, provider)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_account_mapping (
  agent_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (agent_id, account_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE request_logs (
  request_id TEXT PRIMARY KEY,
  agent_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE TABLE request_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  account_id TEXT,
  result TEXT NOT NULL,
  error_type TEXT,
  attempted_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES request_logs(request_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX idx_accounts_status ON accounts(status);
CREATE INDEX idx_accounts_cooldown_until ON accounts(cooldown_until);
CREATE INDEX idx_request_logs_agent_id ON request_logs(agent_id);
CREATE INDEX idx_request_attempts_request_id ON request_attempts(request_id);

CREATE TABLE key_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name TEXT NOT NULL,    -- which OpenRouter account this key belongs to (see poller's OPENROUTER_ACCOUNTS secret)
  key_label TEXT NOT NULL,
  key_hash TEXT NOT NULL,        -- OpenRouter's key identifier, for stable joins if label ever changes
  usage REAL NOT NULL,           -- cumulative usage in credits (USD) as reported by OpenRouter
  limit_value REAL,              -- nullable, per-key limit if set
  disabled INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL       -- ISO 8601 UTC
);
CREATE INDEX idx_key_snapshots_label_time ON key_snapshots (key_label, fetched_at);
CREATE INDEX idx_key_snapshots_hash_time ON key_snapshots (key_hash, fetched_at);
CREATE INDEX idx_key_snapshots_account_hash_time ON key_snapshots (account_name, key_hash, fetched_at);

CREATE TABLE account_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name TEXT NOT NULL,    -- which OpenRouter account this snapshot is for
  total_credits REAL NOT NULL,   -- total purchased
  total_usage REAL NOT NULL,     -- total used
  balance REAL NOT NULL,         -- derived: total_credits - total_usage
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_account_snapshots_time ON account_snapshots (fetched_at);
CREATE INDEX idx_account_snapshots_account_time ON account_snapshots (account_name, fetched_at);

CREATE TABLE telegram_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single row, single operator
  chat_id TEXT NOT NULL,
  daily_alert_hour_utc INTEGER NOT NULL DEFAULT 0,  -- store in UTC, convert for display only
  low_balance_threshold REAL NOT NULL DEFAULT 2.0,
  last_low_balance_alert_at TEXT,        -- ISO 8601 UTC, null until first alert; 6h cooldown enforced against this
  enabled INTEGER NOT NULL DEFAULT 1
);

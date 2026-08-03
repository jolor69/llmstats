ALTER TABLE key_snapshots ADD COLUMN account_name TEXT NOT NULL DEFAULT 'neuralstocks.dev';
ALTER TABLE account_snapshots ADD COLUMN account_name TEXT NOT NULL DEFAULT 'neuralstocks.dev';

CREATE INDEX idx_key_snapshots_account_hash_time ON key_snapshots (account_name, key_hash, fetched_at);
CREATE INDEX idx_account_snapshots_account_time ON account_snapshots (account_name, fetched_at);

-- Fixed-window rate limit state for DDNS update requests.
-- One row is stored per client key so the worker can slow down runaway
-- clients, password guessing, or compromised automation.

CREATE TABLE IF NOT EXISTS ddns_rate_limits (
  key               TEXT    PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count     INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ddns_rate_limits_updated_at ON ddns_rate_limits (updated_at);
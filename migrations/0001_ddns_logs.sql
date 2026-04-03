-- Update history for DDNS record changes.
-- Each row captures one update attempt (success or failure) so operators
-- can audit what happened and debug Synology/cron misconfigurations.
-- A scheduled cron job prunes rows older than DDNS_LOG_RETENTION_DAYS.

CREATE TABLE IF NOT EXISTS ddns_logs (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hostname      TEXT     NOT NULL,
  record_type   TEXT     NOT NULL,  -- 'A' or 'AAAA'
  ip            TEXT     NOT NULL,
  action        TEXT     NOT NULL,  -- 'created', 'updated', 'noop', 'error'
  error_message TEXT,               -- NULL on success
  source        TEXT     NOT NULL   -- 'synology' or 'api'
);

CREATE INDEX IF NOT EXISTS idx_ddns_logs_created_at ON ddns_logs (created_at);

-- Migration 002: Persistent Job Failure Alerts Table
CREATE TABLE IF NOT EXISTS job_failure_alerts (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  error_message TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 3,
  alert_status TEXT NOT NULL DEFAULT 'DISPATCHED',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_failure_alerts_name ON job_failure_alerts (job_name);
CREATE INDEX IF NOT EXISTS idx_job_failure_alerts_created ON job_failure_alerts (created_at);

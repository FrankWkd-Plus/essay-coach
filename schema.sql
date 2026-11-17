CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  referer TEXT NOT NULL,
  country TEXT,
  event_type TEXT NOT NULL,
  content TEXT,
  http_status INTEGER,
  duration_ms INTEGER,
  job_id TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs (created_at);
CREATE INDEX IF NOT EXISTS request_logs_ip_created_at_idx ON request_logs (ip, created_at);
CREATE INDEX IF NOT EXISTS request_logs_event_created_at_idx ON request_logs (event_type, created_at);

CREATE TABLE IF NOT EXISTS grading_jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ip TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL,
  title TEXT NOT NULL,
  essay TEXT NOT NULL,
  requirements TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  model TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS grading_jobs_created_at_idx ON grading_jobs (created_at);
CREATE INDEX IF NOT EXISTS grading_jobs_ip_created_at_idx ON grading_jobs (ip, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

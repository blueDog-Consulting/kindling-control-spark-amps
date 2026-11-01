-- D1 schema for the error-report Worker: one row per distinct error (fingerprint).
-- Apply with: npx wrangler d1 execute kindling-errors --remote --file schema.sql
-- No per-install data: "installs" only counts reports that arrived with first = true.
CREATE TABLE IF NOT EXISTS errors (
  fingerprint   TEXT PRIMARY KEY,
  installs      INTEGER NOT NULL DEFAULT 0,  -- reports with first = true (≈ distinct installs)
  reports       INTEGER NOT NULL DEFAULT 0,
  first_seen    TEXT NOT NULL,               -- server date (YYYY-MM-DD)
  last_seen     TEXT NOT NULL,
  first_version TEXT NOT NULL,
  last_version  TEXT NOT NULL,
  apps          TEXT NOT NULL,               -- e.g. "android,desktop/windows"
  name          TEXT NOT NULL,
  message       TEXT NOT NULL,
  stack         TEXT,
  "where"       TEXT,
  issue_number  INTEGER,
  issue_state   TEXT,                        -- NULL, 'creating', 'open'
  issue_created TEXT                         -- server date the issue was opened
);
CREATE INDEX IF NOT EXISTS errors_issue_created ON errors (issue_created);

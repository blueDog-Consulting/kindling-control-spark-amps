-- Presets hub on kindlingspark.app (Cloudflare D1).
-- Apply with: npx wrangler d1 migrations apply kindling-presets --remote   (CI does this before each deploy)

-- People who have signed in at least once. The email is only used to send
-- sign-in links and is never shown publicly; display_name is.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,                 -- random id
  email        TEXT NOT NULL UNIQUE,             -- lower-cased
  display_name TEXT NOT NULL,
  banned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL                  -- unix ms
);

-- One-time sign-in links. Only a SHA-256 hash of the token is stored.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Signed-in browsers. Only a SHA-256 hash of the cookie value is stored.
CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE presets (
  id          TEXT PRIMARY KEY,                  -- short random id used in URLs
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amp         TEXT NOT NULL DEFAULT '',          -- display name of the amp model, for filtering
  chain       TEXT NOT NULL,                     -- JSON summary: [{ name, slot, on }] x 7
  preset_json TEXT NOT NULL,                     -- normalised Ignitron-compatible preset JSON
  downloads   INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,        -- 1 = hidden by reports or a moderator
  created_at  INTEGER NOT NULL
);
CREATE INDEX presets_new ON presets(hidden, created_at DESC);
CREATE INDEX presets_popular ON presets(hidden, downloads DESC);
CREATE INDEX presets_user ON presets(user_id);

-- One report per reporter per preset (reporter = hashed IP, or user id when signed in).
CREATE TABLE reports (
  preset_id  TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  reporter   TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (preset_id, reporter)
);

-- Sliding-window rate limits (sign-in emails, uploads, reports).
CREATE TABLE rate_events (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX rate_events_key ON rate_events(key, at);

-- Magic-link tokens move from KV get-then-delete (racy, purpose-less) to D1
-- with an atomic conditional-UPDATE consume (docs/03 §5, sweep item P0-2).
-- Only the SHA-256 hash of the raw token is ever stored.

CREATE TABLE auth_tokens (
  token_hash   TEXT PRIMARY KEY,
  contact_id   TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('portal-login','submission-confirm','admin-login')),
  redirect_to  TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT
);

CREATE INDEX idx_auth_tokens_expires ON auth_tokens (expires_at);

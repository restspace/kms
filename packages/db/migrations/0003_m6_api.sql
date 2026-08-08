-- 0003_m6_api — bearer tokens for the public REST API (docs/10 §1).
-- Tokens are organisation-scoped; the event always arrives in the URL path and
-- is checked against the token's organisation on every request (no session-held
-- event state — the surface stays agent-friendly). Only a SHA-256 hash of the
-- token is stored; the prefix is kept for display in the Settings list.

CREATE TABLE api_tokens (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  token_hash             TEXT NOT NULL UNIQUE,
  token_prefix           TEXT NOT NULL,
  created_by_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  last_used_at           TEXT,
  revoked_at             TEXT
);

CREATE INDEX idx_api_tokens_org ON api_tokens(org_id);

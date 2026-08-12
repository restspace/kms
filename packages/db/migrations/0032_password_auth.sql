-- Password authentication (portal sign-up + admin login). portal_accounts
-- (0001) is vestigial - wrong shape (no UNIQUE(contact_id), dead magic-token
-- columns) - so credentials get their own table, one row per contact.
-- pending_* hold a signup's hash until a consumed magic link proves the
-- mailbox; only password_hash/salt are accepted at login.
CREATE TABLE auth_credentials (
  contact_id     TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  password_hash  TEXT,
  salt           TEXT,
  pending_hash   TEXT,
  pending_salt   TEXT,
  algo           TEXT NOT NULL DEFAULT 'pbkdf2-sha256' CHECK (algo IN ('pbkdf2-sha256')),
  iterations     INTEGER NOT NULL,
  set_at         TEXT,
  created_at     TEXT NOT NULL,
  CHECK ((password_hash IS NULL) = (salt IS NULL)),
  CHECK ((pending_hash IS NULL) = (pending_salt IS NULL)),
  CHECK (password_hash IS NOT NULL OR pending_hash IS NOT NULL)
);

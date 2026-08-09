// Single-use, purpose-bound magic tokens in D1 (sweep item P0-2). Only the
// SHA-256 hash is stored; consumption is one conditional UPDATE so concurrent
// callbacks cannot both succeed. Minting returns a prepared statement so
// callers can commit the token inside their own db.batch (P0-3: the
// submission-confirmation link is part of the submission transaction).

export type TokenPurpose = 'portal-login' | 'submission-confirm' | 'admin-login';

export const MAGIC_TTL_SECONDS = 15 * 60; // NFR-4: 15 minutes
/** Confirmation links must survive an inbox delay (consumed once, still short-lived). */
export const CONFIRM_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url — the raw token that goes into the email link. */
export function generateRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface MintedToken {
  /** goes into the link; never stored or logged */
  raw: string;
  /** INSERT for auth_tokens — execute directly or include in a db.batch */
  statement: D1PreparedStatement;
}

export async function mintToken(
  db: D1Database,
  opts: {
    contactId: string;
    eventId: string;
    purpose: TokenPurpose;
    ttlSeconds?: number;
    redirectTo?: string | null;
  },
): Promise<MintedToken> {
  const raw = generateRawToken();
  const hash = await sha256hex(raw);
  const now = Date.now();
  const statement = db
    .prepare(
      `INSERT INTO auth_tokens (token_hash, contact_id, event_id, purpose, redirect_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      hash,
      opts.contactId,
      opts.eventId,
      opts.purpose,
      opts.redirectTo ?? null,
      new Date(now).toISOString(),
      new Date(now + (opts.ttlSeconds ?? MAGIC_TTL_SECONDS) * 1000).toISOString(),
    );
  return { raw, statement };
}

export interface ConsumedToken {
  contact_id: string;
  event_id: string;
  purpose: TokenPurpose;
  redirect_to: string | null;
}

/**
 * Atomically consume a token: the conditional UPDATE succeeds for exactly one
 * caller; replays and expired/wrong-purpose tokens return null.
 */
export async function consumeToken(
  db: D1Database,
  raw: string,
  purposes: readonly TokenPurpose[],
): Promise<ConsumedToken | null> {
  if (!raw || purposes.length === 0) return null;
  const hash = await sha256hex(raw);
  const now = new Date().toISOString();
  const placeholders = purposes.map(() => '?').join(', ');
  return await db
    .prepare(
      `UPDATE auth_tokens SET consumed_at = ?1
       WHERE token_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1
         AND purpose IN (${placeholders})
       RETURNING contact_id, event_id, purpose, redirect_to`,
    )
    .bind(now, hash, ...purposes)
    .first<ConsumedToken>();
}

/** Cron sweep: drop rows expired more than a day ago (hashes only, but tidy). */
export function cleanupExpiredTokensStatement(db: D1Database): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM auth_tokens WHERE expires_at < ?`)
    .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}

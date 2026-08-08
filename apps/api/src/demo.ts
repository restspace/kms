// Demo reset (docs/12 §2: "a reset demo data button" + the nightly cron).
// The seed script is idempotent — it deletes the demo organisation first and
// every owned row cascades — so resetting is simply replaying it. The .sql
// file is bundled as text (wrangler rules) and split into statements here:
// D1's exec() requires one statement per line, which the seed is not.

import seedSql from '../../../packages/db/seed/seed.sql';

/**
 * Split the seed into executable statements. Statement terminators in this
 * file are always `;` at end of line; semicolons inside string literals and
 * comments only ever appear mid-line (verified — HTML entities and prose).
 */
export function seedStatements(): string[] {
  return seedSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((statement) => statement.trim().replace(/;\s*$/, ''))
    .filter((statement) => statement.length > 0);
}

interface TokenSnapshot {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Replay the seed. Chunked batches keep order; the seed's own leading DELETEs make it idempotent. */
export async function resetDemoData(db: D1Database): Promise<number> {
  // API tokens hang off the organisation, so the seed's DELETE would cascade
  // them away — and a judge's token would die at the nightly reset. Snapshot
  // and restore them (created_by is dropped: that contact may not re-exist).
  const tokens = await db
    .prepare(
      `SELECT id, org_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE org_id IN (SELECT id FROM organisations WHERE slug = 'ai-engineer')`,
    )
    .all<TokenSnapshot>();

  const statements = seedStatements();
  const chunkSize = 40;
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize).map((statement) => db.prepare(statement)));
  }

  if (tokens.results.length > 0) {
    await db.batch(
      tokens.results.map((t) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO api_tokens (id, org_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(t.id, t.org_id, t.name, t.token_hash, t.token_prefix, t.created_at, t.last_used_at, t.revoked_at),
      ),
    );
  }
  return statements.length;
}

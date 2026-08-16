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

interface MirrorRow {
  key: string;
  airtable_record_id: string;
}

/**
 * What the Airtable mirror needs to survive a seed replay, per mirrored table.
 *
 * The replay deletes the demo organisation with raw SQL and lets FK cascades do
 * the rest, so none of the delete routes' staging (airtableStage.ts) fires. Left
 * alone, every mirrored row would come back with a NULL airtable_record_id and
 * the next sweep would create a second Airtable record for it, orphaning the
 * first — a full duplicate set of the demo data every night.
 *
 * The seed's ids are deterministic, so the fix is to carry the record ids across
 * the replay rather than to delete and re-create: rows that come back keep their
 * Airtable record (the sweep updates it in place), and only rows that do *not*
 * come back — created by demo users during the day — are staged for deletion.
 */
async function snapshotMirrorIds(db: D1Database): Promise<Map<string, MirrorRow[]>> {
  const snapshot = new Map<string, MirrorRow[]>();
  for (const [table, keyColumn] of Object.entries(MIRRORED_TABLES)) {
    const rows = await db
      .prepare(`SELECT ${keyColumn} AS key, airtable_record_id FROM ${table} WHERE airtable_record_id IS NOT NULL`)
      .all<MirrorRow>();
    if (rows.results.length > 0) snapshot.set(table, rows.results);
  }
  return snapshot;
}

/**
 * Put the record ids back on the rows the replay re-created, and stage the rest
 * for deletion. Survivor detection rides on the UPDATE's own `changes` count —
 * a re-created row matches by id, a row that is gone for good matches nothing —
 * so this costs one statement per snapshotted row and no extra reads.
 *
 * Finally the watermarks are cleared. The seed carries fixed timestamps in the
 * past, so without this the next sweep would consider every restored row older
 * than its watermark and push nothing, leaving Airtable showing whatever the
 * demo's users had edited it to. Cleared, the sweep re-pushes from epoch — over
 * the restored record ids, so it is an update in place, not a second copy.
 */
async function restoreMirrorIds(db: D1Database, snapshot: Map<string, MirrorRow[]>): Promise<void> {
  const queuedAt = new Date().toISOString();
  const orphaned: Array<{ table: string; recordId: string }> = [];

  for (const [table, rows] of snapshot) {
    for (let i = 0; i < rows.length; i += MIRROR_CHUNK) {
      const chunk = rows.slice(i, i + MIRROR_CHUNK);
      const results = await db.batch(
        chunk.map((row) =>
          db
            .prepare(`UPDATE ${table} SET airtable_record_id = ? WHERE ${MIRRORED_TABLES[table]} = ?`)
            .bind(row.airtable_record_id, row.key),
        ),
      );
      results.forEach((result, j) => {
        if ((result.meta?.changes ?? 0) === 0) {
          orphaned.push({ table, recordId: chunk[j]!.airtable_record_id });
        }
      });
    }
  }

  for (let i = 0; i < orphaned.length; i += MIRROR_CHUNK) {
    await db.batch(
      orphaned.slice(i, i + MIRROR_CHUNK).map((o) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO airtable_pending_deletes (table_name, record_id, queued_at)
             VALUES (?, ?, ?)`,
          )
          .bind(o.table, o.recordId, queuedAt),
      ),
    );
  }

  await db.prepare('DELETE FROM airtable_sync_state').run();
}

/**
 * Mirrored table → the column its Airtable record id is keyed by, in
 * SYNC_TABLES order. Both halves are interpolated into SQL, so this is a
 * closed list; it must stay in step with SYNC_TABLES (packages/airtable),
 * which demo-airtable-mirror.test.ts asserts.
 */
export const MIRRORED_TABLES: Record<string, string> = {
  events: 'id',
  contacts: 'id',
  submissions: 'id',
  tasks: 'id',
  reviews: 'id',
  tracks: 'id',
  rooms: 'id',
  tags: 'id',
  event_contacts: 'mirror_id',
  message_log: 'id',
  submission_comments: 'id',
  pipeline_cards: 'id',
  pipeline_activity: 'id',
  file_assets: 'id',
  file_requests: 'id',
  portal_form_responses: 'id',
};
const MIRROR_CHUNK = 50;

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

/**
 * Replay the seed. Chunked batches keep order; the seed's own leading DELETEs
 * make it idempotent.
 *
 * `redirectEmail` overrides the stored tester mailbox for this reset only —
 * used by the Settings screen, which saves the setting and resets in one
 * action and so already holds the new value. Omitted (the landing page button
 * and the nightly cron), the stored setting applies, so a demo configured to
 * deliver to a tester's inbox stays that way across the 09:00 UTC replay.
 */
export async function resetDemoData(db: D1Database, redirectEmail?: string | null): Promise<number> {
  // API tokens hang off the organisation, so the seed's DELETE would cascade
  // them away — and a judge's token would die at the nightly reset. Snapshot
  // and restore them (created_by is dropped: that contact may not re-exist).
  const tokens = await db
    .prepare(
      `SELECT id, org_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE org_id IN (SELECT id FROM organisations WHERE slug = 'ai-engineer')`,
    )
    .all<TokenSnapshot>();

  // Read before the replay wipes them; applied after. Empty whenever the mirror
  // has never run, which makes the whole thing a no-op on a normal deployment.
  const mirrorIds = await snapshotMirrorIds(db);

  // The seed never mentions `outbox`, so without this every reset leaves the
  // previous day's rows behind while cascading message_log away — and the next
  // send for a seeded (contact, submission) pair regenerates a key outbox
  // already holds as 'done', so its enqueue no-ops and the message never
  // leaves. outbox is a work queue, not a ledger: message_log is what answers
  // "did they get it?", and the seed replay is rebuilding exactly the rows
  // these jobs referred to. Anything genuinely mid-flight at 09:00 UTC is a
  // demo send seconds old, which the replay is about to invalidate anyway.
  await db.prepare('DELETE FROM outbox').run();

  const statements = seedStatements();
  const chunkSize = 40;
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize).map((statement) => db.prepare(statement)));
  }

  if (mirrorIds.size > 0) {
    // Bookkeeping for an optional integration: a failure here leaves the demo
    // reset itself intact, so report rather than throw (as with the redirect).
    try {
      await restoreMirrorIds(db, mirrorIds);
    } catch (error) {
      console.error('demo reset: airtable record-id restore failed', error);
    }
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

  // Last, so it runs over the freshly seeded rows rather than being undone by
  // them. A failure here must not present the whole reset as failed — the seed
  // is already in place — so it is reported, not thrown.
  const { applyEmailRedirect, readRedirectEmail } = await import('./demoEmails');
  const redirect = redirectEmail !== undefined ? redirectEmail : await readRedirectEmail(db);
  try {
    await applyEmailRedirect(db, redirect);
  } catch (error) {
    console.error('demo reset: email redirect failed', error);
  }

  return statements.length;
}

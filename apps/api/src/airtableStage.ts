// Stage Airtable-record deletes for the mirror sweep (workplan-9 §10.2).
// Delete routes include the returned statement in their db.batch() *before*
// the DELETE itself: it snapshots the doomed rows' airtable_record_ids into
// airtable_pending_deletes, which jobs/airtableSync.ts drains. Cheap enough to
// run unconditionally — with the mirror off, airtable_record_id is NULL
// everywhere and the INSERT...SELECT matches nothing.
//
// For cascades the caller stages each affected table explicitly (e.g. deleting
// a submission also stages its reviews) — FK cascades fire inside SQLite where
// no application code can see the doomed rows afterwards.

/** Mirrored tables only — interpolated into SQL, so keep this a closed union. */
export type MirroredTable =
  | 'events'
  | 'submissions'
  | 'contacts'
  | 'tasks'
  | 'reviews'
  | 'tracks'
  | 'rooms'
  | 'tags';

/**
 * Statement inserting pending-delete rows for every row of `table` matching
 * `whereSql` that has an airtable_record_id. `whereSql` must be a literal at
 * the call site; values go through `binds`.
 */
export function stageAirtableDeletes(
  d1: D1Database,
  table: MirroredTable,
  whereSql: string,
  ...binds: unknown[]
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT OR IGNORE INTO airtable_pending_deletes (table_name, record_id, queued_at)
       SELECT '${table}', airtable_record_id, ? FROM ${table}
       WHERE airtable_record_id IS NOT NULL AND (${whereSql})`,
    )
    .bind(new Date().toISOString(), ...binds);
}

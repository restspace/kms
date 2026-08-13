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
  | 'tags'
  // Second wave (migration 0045). Most of these only ever die by cascade from a
  // row above, so their staging happens at the parent's delete route.
  | 'event_contacts'
  | 'message_log'
  | 'submission_comments'
  | 'pipeline_cards'
  | 'pipeline_activity'
  | 'file_assets'
  | 'file_requests'
  | 'portal_form_responses';

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

/**
 * The mirrored rows that die with a contact: their pipeline card and its
 * activity, their portal-form responses, and — when the whole contact goes —
 * every roster row. Reviews and the contact row itself stay at the call sites,
 * which each guard them differently.
 *
 * `lastMembershipOnly` matches the delete-a-roster-entry routes, where the
 * contact row only goes if that was their last event; the same NOT EXISTS has
 * to gate the cascades or a contact who still belongs elsewhere loses their
 * pipeline card from Airtable while keeping it in D1. Pass it exactly when the
 * accompanying `DELETE FROM contacts` carries that guard.
 */
export function stageContactCascades(
  d1: D1Database,
  contactId: string,
  opts: { lastMembershipOnly?: boolean; includeRoster?: boolean } = {},
): D1PreparedStatement[] {
  // The guard's own `?` comes last in the string, so its bind just appends.
  const guard = opts.lastMembershipOnly
    ? ' AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = ?)'
    : '';
  const binds = opts.lastMembershipOnly ? [contactId, contactId] : [contactId];
  const statements = [
    stageAirtableDeletes(d1, 'pipeline_cards', `contact_id = ?${guard}`, ...binds),
    stageAirtableDeletes(
      d1,
      'pipeline_activity',
      `card_id IN (SELECT id FROM pipeline_cards WHERE contact_id = ?)${guard}`,
      ...binds,
    ),
    stageAirtableDeletes(d1, 'portal_form_responses', `contact_id = ?${guard}`, ...binds),
  ];
  if (opts.includeRoster) statements.push(stageAirtableDeletes(d1, 'event_contacts', 'contact_id = ?', contactId));
  return statements;
}

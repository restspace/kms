// Per-event revision marker in KV (sweep item P2-16). Writing routes bump it;
// the dashboard (and any other cached read) keys its ETag + KV payload cache
// on the current value, so a 304/hit costs zero D1 queries. Timestamps are
// good enough: KV has no atomic increment, and the only requirement is that
// the value *changes* after a relevant write.

import type { Env } from './env';

// ---------------------------------------------------------------------------
// Entity content revisions (workplan 14 Wave E, decision D8). content_revisions
// (0023, generalised by 0031) stores one PRE-edit snapshot per content edit.
// Submissions keep their dedicated title/description columns and insert
// in-route (evaluation.ts / portal.ts, unchanged); every other entity type
// records through these helpers: the watched fields go into the `payload`
// JSON column, keyed by `entity_type` + `entity_id`.
// ---------------------------------------------------------------------------

export type RevisionSource = 'admin' | 'portal';

/** null/undefined and '' compare equal — every writer normalises blanks to
 * NULL, so "cleared" vs "was never set" is not a content change. */
const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * True when any watched field the edit actually carries differs from the
 * stored row — the "snapshot only when watched fields actually change" rule,
 * matching how evaluation.ts skips a row for format/track-only PUTs.
 * `incoming` holds only the fields the request sent; absent keys can't change
 * anything and are ignored.
 */
export function watchedFieldsChanged(
  before: Record<string, unknown>,
  incoming: Record<string, unknown>,
  watched: readonly string[],
): boolean {
  return watched.some((k) => k in incoming && norm(incoming[k]) !== norm(before[k]));
}

/**
 * The INSERT for one non-submission snapshot row, as a prepared statement so
 * callers can batch it with the UPDATE it precedes (history and the change it
 * records commit together, same discipline as the submission paths).
 * `payload` should be the full watched-field set's PRE-edit values, so a
 * restore is a single "write these back" with no reconstruction.
 */
export function entityRevisionInsert(
  db: D1Database,
  args: {
    eventId: string;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    editedBy: string | null;
    editedByName: string | null;
    source: RevisionSource;
    editedAt: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO content_revisions
         (id, event_id, entity_type, entity_id, payload, edited_by, edited_by_name, source, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.eventId,
      args.entityType,
      args.entityId,
      JSON.stringify(args.payload),
      args.editedBy,
      args.editedByName,
      args.source,
      args.editedAt,
    );
}

/**
 * Newest-first history rows for one entity, payload parsed back into fields —
 * the same shape GET /submissions/:id/revisions returns, minus the dedicated
 * title/description columns.
 */
export async function listEntityRevisions(
  db: D1Database,
  eventId: string,
  entityType: string,
  entityId: string,
): Promise<Array<Record<string, unknown>>> {
  const { results } = await db
    .prepare(
      `SELECT id, payload, edited_by, edited_by_name, source, edited_at
       FROM content_revisions
       WHERE entity_type = ? AND entity_id = ? AND event_id = ?
       ORDER BY edited_at DESC, id DESC`,
    )
    .bind(entityType, entityId, eventId)
    .all<{ id: string; payload: string | null; edited_by: string | null; edited_by_name: string | null; source: string; edited_at: string }>();
  return (results ?? []).map(({ payload, ...rest }) => {
    let fields: Record<string, unknown> = {};
    try {
      const parsed: unknown = payload ? JSON.parse(payload) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    } catch {
      // A malformed payload renders as an empty snapshot rather than a 500.
    }
    return { ...rest, fields };
  });
}

export async function bumpEventRevision(env: Env, eventId: string): Promise<void> {
  try {
    await env.KV.put(`rev:${eventId}`, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  } catch {
    // A missed bump only means one stale cache window (short TTL backstop).
  }
}

export async function getEventRevision(env: Env, eventId: string): Promise<string> {
  return (await env.KV.get(`rev:${eventId}`)) ?? '0';
}

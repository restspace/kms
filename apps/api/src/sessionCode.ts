// Session-code allocation (docs/04 §5, sweep item P0-1). `SESS-n` is derived
// from the highest existing numeric suffix *inside the INSERT itself*: D1 is a
// single writer, so an in-statement subquery cannot interleave with another
// create the way a read-then-write pair can. `UNIQUE (event_id, code)` stays
// the backstop; callers retry once on a collision.
//
// Both writers of session codes (the CFP submit pipeline and the agenda's
// "+ Add Session") share this fragment so the numbering can never diverge.

/**
 * SQL expression evaluating to the next `SESS-n` for one event. `eventParam`
 * is the *numbered* placeholder holding the event id — the fragment is meant
 * to be embedded in statements that bind by index (`?1`, `?2`, …), so it can
 * reuse the caller's event-id parameter without a second binding.
 */
export const nextSessionCodeSql = (eventParam: string): string =>
  `'SESS-' || (COALESCE((SELECT MAX(CAST(SUBSTR(sc.code, 6) AS INTEGER)) FROM submissions sc
                         WHERE sc.event_id = ${eventParam} AND sc.code LIKE 'SESS-%'), 0) + 1)`;

/**
 * Read the code the allocator would produce next. Used only to render text
 * that has to exist *before* the batch commits (the confirmation email quotes
 * the code); the stored value always comes from `nextSessionCodeSql`, and the
 * writing statement re-asserts the two agree.
 */
export async function peekNextSessionCode(db: D1Database, eventId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(code, 6) AS INTEGER)), 0) AS n
       FROM submissions WHERE event_id = ? AND code LIKE 'SESS-%'`,
    )
    .bind(eventId)
    .first<{ n: number }>();
  return `SESS-${(row?.n ?? 0) + 1}`;
}

/** True when an error is the `UNIQUE (event_id, code)` backstop firing. */
export function isSubmissionCodeCollision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /UNIQUE constraint failed: submissions\.(event_id|code)/i.test(message);
}

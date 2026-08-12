// ABS-11: participant-write primitives shared by the CFP wizard's submit
// endpoint (routes/submit.tsx) and the two new speaker-portal co-author
// routes (routes/portal.ts). Extracted verbatim from submit.tsx's per-
// participant batch block and evaluation.ts's snapshotParticipantsRevision —
// same SQL, same semantics, just callable from more than one route now.

import { entityRevisionInsert, type RevisionSource } from './revision';

/** One participant's contact/event_contacts/submission_participants writes. */
export interface PortalParticipantData {
  eventId: string;
  /**
   * Not read directly below — every statement derives org scoping from
   * `eventId` via a `(SELECT org_id FROM events WHERE id = ?)` subquery, the
   * same way the code being extracted here always did. Accepted anyway so a
   * caller that already has the org id on hand (the portal ctx does) can
   * pass it through without contorting itself to omit it.
   */
  orgId?: string;
  submissionId: string;
  email: string;
  firstName: string;
  lastName: string;
  mobilePhone?: string | null;
  biography?: string | null;
  role: string;
  position: number;
  ts: string;
  /** True when this participant IS the acting contact (submitter, or the
   *  portal user adding themselves back). Governs both COALESCE orders below
   *  and whether confirmed_at is stamped. */
  own?: boolean;
  /** JSON-encoded participant-question answers; '{}' when the caller (the
   *  portal add-co-author form) collects no such answers. */
  answersJson?: string;
}

const orNull = (v: string | null | undefined): string | null => (v ? v : null);

/**
 * Build the four prepared statements that upsert one participant's contact,
 * attach/seed their event_contacts row, merge their biography, and insert
 * their submission_participants row. Callers batch these together with
 * whatever else the write needs (e.g. a snapshotParticipantsRevision
 * statement placed BEFORE them, since a revision is a pre-edit snapshot).
 *
 * Security property, preserved byte-for-byte from submit.tsx: a submitter
 * (or portal co-author adder) who only knows another person's email must
 * NOT be able to overwrite that person's own self-managed profile — hence
 * the two-COALESCE order below, keyed on `own`. This holds across both
 * tables the profile spans: identity on `contacts`, biography on this
 * event's `event_contacts` row.
 */
export function buildPortalParticipantStatements(
  db: D1Database,
  args: PortalParticipantData,
): D1PreparedStatement[] {
  const { eventId, submissionId, email, firstName, lastName, role, position, ts } = args;
  const own = args.own === true;
  const mobilePhone = orNull(args.mobilePhone);
  const biography = orNull(args.biography);
  const answersJson = args.answersJson ?? '{}';

  const identityMerge = own
    ? `first_name = COALESCE(excluded.first_name, contacts.first_name),
       last_name = COALESCE(excluded.last_name, contacts.last_name),
       mobile_phone = COALESCE(excluded.mobile_phone, contacts.mobile_phone)`
    : `first_name = COALESCE(contacts.first_name, excluded.first_name),
       last_name = COALESCE(contacts.last_name, excluded.last_name),
       mobile_phone = COALESCE(contacts.mobile_phone, excluded.mobile_phone)`;
  // Same rule, applied twice: `seedBio` orders the typed biography against
  // the profile carried over from another event in the org, `bioMerge`
  // orders it against the one already stored for THIS event.
  const seedBio = own ? 'COALESCE(?3, prev.biography)' : 'COALESCE(prev.biography, ?3)';
  const bioMerge = own ? 'COALESCE(?3, biography)' : 'COALESCE(biography, ?3)';

  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO contacts (id, org_id, email, first_name, last_name, mobile_phone, created_at, updated_at)
         VALUES (?1, (SELECT org_id FROM events WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT (org_id, lower(email)) DO UPDATE SET ${identityMerge}, updated_at = ?7`,
      )
      .bind(crypto.randomUUID(), eventId, email, orNull(firstName), orNull(lastName), mobilePhone, ts),
  );

  // Attach-and-seed, the SQL twin of db.contacts.attachToEvent (the helper
  // itself cannot be called here — every write in these endpoints is one
  // batch). A speaker returning from another event in the org is matched by
  // the statement above and picks their newest profile up here rather than
  // starting blank; the headshot is never seeded, it is an event-scoped
  // asset. `prev` excludes this event so the seed can never read back the
  // row being written.
  //
  // DO NOTHING, not DO UPDATE: the merge below has to compare the typed
  // biography against the stored one, and a seeded `excluded` would let
  // another event's bio win that comparison.
  statements.push(
    db
      .prepare(
        `INSERT INTO event_contacts
           (event_id, contact_id, biography, company, job_title, added_at, source)
         SELECT ?1, c.id, ${seedBio}, prev.company, prev.job_title, ?4, 'cfp'
           FROM contacts c
           JOIN events ev ON ev.id = ?1
           LEFT JOIN event_contacts prev
             ON prev.contact_id = c.id
            AND prev.event_id = (SELECT p2.event_id FROM event_contacts p2
                                   JOIN events pe ON pe.id = p2.event_id
                                  WHERE p2.contact_id = c.id
                                    AND p2.event_id <> ?1
                                    AND pe.org_id = ev.org_id
                                  ORDER BY p2.added_at DESC LIMIT 1)
          WHERE c.org_id = ev.org_id AND lower(c.email) = ?2
         ON CONFLICT (event_id, contact_id) DO NOTHING`,
      )
      .bind(eventId, email, biography, ts),
  );

  // The profile half of the same two-COALESCE rule. The row is guaranteed to
  // exist by the statement above, so this is an UPDATE rather than a second
  // upsert.
  statements.push(
    db
      .prepare(
        `UPDATE event_contacts SET biography = ${bioMerge}
          WHERE event_id = ?1
            AND contact_id = (SELECT c.id FROM contacts c
                               WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?1)
                                 AND lower(c.email) = ?2)`,
      )
      .bind(eventId, email, biography),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO submission_participants
           (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at, answers_json,
            title_at_time, org_at_time)
         SELECT ?1, ?2, c.id, ?3, ?4, ?5, ?6, ?7, ec.job_title, ec.company FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?8
         WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?8)
           AND lower(c.email) = ?9
           AND EXISTS (SELECT 1 FROM submissions s WHERE s.id = ?2)`,
      )
      .bind(
        crypto.randomUUID(),
        submissionId,
        role,
        position,
        own ? 1 : 0,
        own ? ts : null,
        answersJson,
        eventId,
        email,
      ),
  );

  return statements;
}

/**
 * Pre-edit snapshot of a submission's full participant roster, batched ahead
 * of the INSERT/UPDATE/DELETE it precedes (same commit-together discipline
 * as the submission title/description revision in portal.ts and the
 * contact/settings ones in adminApi.ts). Recorded unconditionally — unlike a
 * field-diff, a roster add/remove/role-change IS the content change, so
 * there is no "unchanged, skip it" case to filter for.
 *
 * Moved here from evaluation.ts (F5/D7) so the new portal co-author routes
 * can share it, `source` parameterised so a portal-made change is
 * attributed distinctly from an organiser-made one.
 */
export async function snapshotParticipantsRevision(
  db: D1Database,
  args: {
    eventId: string;
    submissionId: string;
    editedBy: string | null;
    editedByName: string | null;
    editedAt: string;
    source: RevisionSource;
  },
): Promise<D1PreparedStatement> {
  const { results } = await db
    .prepare(
      `SELECT sp.id AS participant_id, sp.contact_id, sp.role, sp.position, sp.is_primary_contact,
              c.first_name, c.last_name, c.email
       FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ? ORDER BY sp.position`,
    )
    .bind(args.submissionId)
    .all();
  return entityRevisionInsert(db, {
    eventId: args.eventId,
    entityType: 'submission_participants',
    entityId: args.submissionId,
    payload: { participants: results ?? [] },
    editedBy: args.editedBy,
    editedByName: args.editedByName,
    source: args.source,
    editedAt: args.editedAt,
  });
}

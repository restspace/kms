// Workspace access: which events can this staff session see?
//
// The event stopped being a routing context and became a filter dimension
// (manual review, "Events should be scoped within the Workspace"). A session
// still carries one `eventId` — the *current* event for per-event surfaces —
// but list queries span every event in the same organisation where this
// person's email holds an owner/admin/reviewer seat. Contacts are org-scoped rows
// since 0015 — a different row per organisation — so the identity that spans
// events is still the email, resolved per request against the database rather
// than trusted from the cookie.

import type { Context } from 'hono';
import type { Role } from '@kms/core';
import type { Env } from './env';
import type { SessionPayload } from './session';

export interface AccessibleEvent {
  event_id: string;
  event_name: string;
  role: Role;
  contact_id: string;
}

/** Hono variables every /app/api route may read (the guard owns `session`). */
export type AccessEnv = {
  Bindings: Env;
  Variables: { session: SessionPayload; accessibleEvents?: AccessibleEvent[] };
};

/**
 * Events in the session's organisation where this email holds a staff seat.
 * Speakers never reach /app/api, so only owner/admin/reviewer are spanned.
 */
export async function getAccessibleEvents(
  db: D1Database,
  session: SessionPayload,
): Promise<AccessibleEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT eu.event_id, e.name AS event_name, eu.role, eu.contact_id
       FROM event_users eu
       JOIN contacts ct ON ct.id = eu.contact_id
       -- event_contacts carries the membership that contacts.event_id used to
       -- (0015). Keeping it as a join preserves the original guard exactly: a
       -- staff seat only counts where the person is on that event's roster.
       JOIN event_contacts ec ON ec.contact_id = ct.id AND ec.event_id = eu.event_id
       JOIN events e ON e.id = eu.event_id
       WHERE ct.email = ?
         AND e.org_id = (SELECT org_id FROM events WHERE id = ?)
         AND eu.role IN ('owner', 'admin', 'reviewer')
       ORDER BY e.starts_at, e.name`,
    )
    .bind(session.email, session.eventId)
    .all<AccessibleEvent>();
  return results;
}

/** Per-request memoised form — the guard-fronted routes call this, not the raw query. */
export async function accessibleEvents<E extends AccessEnv>(
  c: Context<E>,
): Promise<AccessibleEvent[]> {
  const cached = c.get('accessibleEvents') as AccessibleEvent[] | undefined;
  if (cached) return cached;
  const events = await getAccessibleEvents(c.env.DB, c.get('session'));
  c.set('accessibleEvents', events);
  return events;
}

/** Ids only, always including the session's own event so a seat-less legacy
 * session still sees its current event (the cookie was minted against it). */
export async function accessibleEventIds<E extends AccessEnv>(c: Context<E>): Promise<string[]> {
  const ids = (await accessibleEvents(c)).map((e) => e.event_id);
  const current = c.get('session').eventId;
  return ids.includes(current) ? ids : [current, ...ids];
}

/**
 * Guard a route that names an explicit event: returns the seat, or null when
 * the target is outside the accessible set (callers answer 403).
 */
export async function requireEventAccess<E extends AccessEnv>(
  c: Context<E>,
  eventId: string,
): Promise<AccessibleEvent | null> {
  if (!eventId) return null;
  const events = await accessibleEvents(c);
  return events.find((e) => e.event_id === eventId) ?? null;
}

/** True when the role may write (owner/admin); reviewers are read-only. */
export const isWriter = (role: Role | undefined): boolean => role === 'owner' || role === 'admin';

// ---------------------------------------------------------------------------
// Portal (speaker) access — workplan-5 §5
// ---------------------------------------------------------------------------

/** The caller's identity AT one specific event: the org-scoped contact row that
 *  event's organisation holds for this email, plus the role that event grants. */
export interface EventActor {
  contactId: string;
  role: Role;
}

/**
 * Resolve who the session is *at `eventId`*, independent of the event the
 * cookie was minted against.
 *
 * Email, not `session.contactId`, is the key: contacts are org-scoped since
 * 0015, so the same person is a DIFFERENT contact row in a different org and
 * the event is what decides the org. The cookie's `contactId` is only valid
 * inside its own organisation, and the cookie's `role` is only the role at its
 * own event — an owner at event A must not arrive at event B holding owner.
 * Both are therefore re-derived here rather than trusted.
 *
 * Returns null when this email has no relationship to the event at all: either
 * a roster row (`event_contacts`) or a staff seat (`event_users`) counts, so a
 * staff account that was never added to the roster still resolves.
 */
export async function resolveEventActor(
  db: D1Database,
  email: string,
  eventId: string,
): Promise<EventActor | null> {
  const row = await db
    .prepare(
      `SELECT c.id AS contact_id, COALESCE(eu.role, 'speaker') AS role
         FROM contacts c
         LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?1
         LEFT JOIN event_users    eu ON eu.contact_id = c.id AND eu.event_id = ?1
        -- The org predicate is the tenancy guard: it pins the lookup to the one
        -- organisation that owns this event, where (org_id, lower(email)) is
        -- unique, so at most one contact can ever match.
        WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?1)
          AND lower(c.email) = lower(?2)
          AND (ec.contact_id IS NOT NULL OR eu.contact_id IS NOT NULL)`,
    )
    .bind(eventId, email)
    .first<{ contact_id: string; role: Role }>();
  return row ? { contactId: row.contact_id, role: row.role } : null;
}

/** One row of the portal's event switcher. */
export interface PortalEvent {
  event_id: string;
  event_slug: string;
  event_name: string;
  contact_id: string;
}

/**
 * Events in the current event's organisation whose portal this email may open.
 *
 * Deliberately NOT `SELECT event_id FROM event_contacts WHERE contact_id = ?`
 * (§5): bare membership would make the switcher disclose "event X has you on
 * file" to anyone who was ever imported into a roster — including rosters bought
 * or scraped by another team in the same org. The list is gated on a real
 * relationship instead: a submission they filed or participate in, a task
 * assigned to them, or a staff seat. Membership is still required on top of
 * that, because the roster row is what carries their profile for the event.
 *
 * Org-constrained for the same reason resolveEventActor is: the contact row is
 * only meaningful inside one organisation, so the switcher spans one org.
 */
export async function getPortalEvents(
  db: D1Database,
  args: { email: string; eventId: string },
): Promise<PortalEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS event_id, e.slug AS event_slug, e.name AS event_name, c.id AS contact_id
         FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id
         JOIN events e ON e.id = ec.event_id
        WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?2)
          -- e.org_id = c.org_id is not implied by the joins above: nothing in the
          -- schema stops an event_contacts row pointing at an event in another
          -- org, and one bad row must not leak an out-of-org event into the list.
          AND e.org_id = c.org_id
          AND lower(c.email) = lower(?1)
          AND (
            EXISTS (SELECT 1 FROM submissions s
                     WHERE s.event_id = e.id AND s.submitter_contact_id = c.id)
            OR EXISTS (SELECT 1 FROM submission_participants sp
                       JOIN submissions s2 ON s2.id = sp.submission_id AND s2.event_id = e.id
                        WHERE sp.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM task_assignments ta
                       JOIN tasks t ON t.id = ta.task_id AND t.event_id = e.id
                        WHERE ta.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM event_users eu
                        WHERE eu.event_id = e.id AND eu.contact_id = c.id)
          )
        ORDER BY e.starts_at, e.name`,
    )
    .bind(args.email, args.eventId)
    .all<PortalEvent>();
  return results;
}

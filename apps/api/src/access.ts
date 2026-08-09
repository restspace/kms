// Workspace access: which events can this staff session see?
//
// The event stopped being a routing context and became a filter dimension
// (manual review, "Events should be scoped within the Workspace"). A session
// still carries one `eventId` — the *current* event for per-event surfaces —
// but list queries span every event in the same organisation where this
// person's email holds an owner/admin/reviewer seat. Contacts are event-scoped
// rows, so the identity that spans events is the email, resolved per request
// against the database rather than trusted from the cookie.

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
       JOIN contacts ct ON ct.id = eu.contact_id AND ct.event_id = eu.event_id
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

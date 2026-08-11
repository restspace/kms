// Minimal seed helpers for workers tests. Deliberately NOT the demo seed:
// each test builds only the rows it needs against the migrated schema.
// Sessions are stateless signed cookies, so an authenticated SELF.fetch just
// needs a token minted with the test SESSION_SECRET.

import { env } from 'cloudflare:test';
import type { Role } from '@kms/core';
import { createSessionToken, SESSION_COOKIE } from '../src/session';

const ts = '2026-08-01T00:00:00Z';

export async function createOrg(id = 'org-test-1'): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)`,
  ).bind(id, 'Test Org', id, ts).run();
  return id;
}

export async function createEvent(
  overrides: Partial<{
    id: string; org_id: string; name: string; slug: string;
    starts_at: string; ends_at: string; timezone: string;
    default_submission_limit: number;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `evt-${crypto.randomUUID()}`;
  // Each event gets its own organisation unless the caller names one. Contacts
  // are unique per (org, email) since 0015, and storage persists across it()
  // blocks in a file — a shared default org would make the same email collide
  // between tests that are supposed to be independent. Tests that genuinely
  // want two events in one org pass org_id explicitly.
  const orgId = overrides.org_id ?? `org-${crypto.randomUUID()}`;
  const existingOrg = await env.DB.prepare('SELECT id FROM organisations WHERE id = ?').bind(orgId).first();
  if (!existingOrg) await createOrg(orgId);
  await env.DB.prepare(
    `INSERT INTO events (id, org_id, name, slug, type, timezone, starts_at, ends_at, default_submission_limit, agenda_published, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'conference', ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(
    id,
    orgId,
    overrides.name ?? 'Test Event',
    overrides.slug ?? id,
    overrides.timezone ?? 'UTC',
    overrides.starts_at ?? '2026-10-01T08:00:00Z',
    overrides.ends_at ?? '2026-10-02T18:00:00Z',
    overrides.default_submission_limit ?? 3,
    ts,
    ts,
  ).run();
  return id;
}

export async function createContact(
  eventId: string,
  overrides: Partial<{
    id: string; email: string; first_name: string; last_name: string;
    biography: string; company: string; job_title: string; notes: string; headshot_asset_id: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `con-${crypto.randomUUID()}`;
  const event = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventId).first<{ org_id: string }>();
  if (!event) throw new Error(`createContact: no event ${eventId}`);
  await env.DB.prepare(
    `INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    event.org_id,
    overrides.email ?? `${id}@example.com`,
    overrides.first_name ?? 'Test',
    overrides.last_name ?? 'Person',
    ts,
    ts,
  ).run();
  await env.DB.prepare(
    `INSERT INTO event_contacts (event_id, contact_id, biography, headshot_asset_id, company, job_title, notes, added_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin')`,
  ).bind(
    eventId,
    id,
    overrides.biography ?? null,
    overrides.headshot_asset_id ?? null,
    overrides.company ?? null,
    overrides.job_title ?? null,
    overrides.notes ?? null,
    ts,
  ).run();
  return id;
}

/** Attach an EXISTING (already org-scoped) contact to a second event, for
 * cross-event scenarios: same person, different event's roster/profile. */
export async function attachContactToEvent(
  eventId: string,
  contactId: string,
  overrides: Partial<{
    biography: string; company: string; job_title: string; notes: string; headshot_asset_id: string;
    source: 'import' | 'cfp' | 'admin' | 'migration';
  }> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_contacts (event_id, contact_id, biography, headshot_asset_id, company, job_title, notes, added_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    eventId,
    contactId,
    overrides.biography ?? null,
    overrides.headshot_asset_id ?? null,
    overrides.company ?? null,
    overrides.job_title ?? null,
    overrides.notes ?? null,
    ts,
    overrides.source ?? 'admin',
  ).run();
}

export async function createEventUser(eventId: string, contactId: string, role: Role): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(eventId, contactId, role, ts, ts).run();
}

/** Cookie header value for an authenticated SELF.fetch request. */
export async function sessionCookieFor(opts: {
  contactId: string;
  eventId: string;
  eventSlug?: string;
  email?: string;
  role?: Role;
}): Promise<string> {
  const token = await createSessionToken(
    {
      contactId: opts.contactId,
      eventId: opts.eventId,
      eventSlug: opts.eventSlug ?? opts.eventId,
      email: opts.email ?? 'test@example.com',
      role: opts.role ?? 'speaker',
    },
    env.SESSION_SECRET,
  );
  return `${SESSION_COOKIE}=${token}`;
}

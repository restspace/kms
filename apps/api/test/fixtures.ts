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
  const orgId = overrides.org_id ?? 'org-test-1';
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
  overrides: Partial<{ id: string; email: string; first_name: string; last_name: string }> = {},
): Promise<string> {
  const id = overrides.id ?? `con-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO contacts (id, event_id, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    eventId,
    overrides.email ?? `${id}@example.com`,
    overrides.first_name ?? 'Test',
    overrides.last_name ?? 'Person',
    ts,
    ts,
  ).run();
  return id;
}

export async function createEventUser(eventId: string, contactId: string, role: Role): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_users (id, event_id, contact_id, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(`eu-${crypto.randomUUID()}`, eventId, contactId, role, ts).run();
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

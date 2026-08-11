// Extra seed helpers for the admin-API lane (BE-3). test/fixtures.ts stays the
// shared minimum; anything only the /app/api tests need lives here.

import { env } from 'cloudflare:test';
import type { Role } from '@kms/core';
import { createSessionToken, SESSION_COOKIE } from '../src/session';

const ts = '2026-08-01T00:00:00Z';
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export async function createOrg(id = 'org-test-1', name = 'Test Org'): Promise<string> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
  ).bind(id, name, id, ts).run();
  return id;
}

export async function seedEvent(
  overrides: Partial<{
    id: string; org_id: string; name: string; slug: string;
    starts_at: string; ends_at: string; timezone: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? uid('evt');
  // Own org per event unless the caller names one — see the note in fixtures.ts:
  // contacts are unique per (org, email) and storage persists across it() blocks.
  const orgId = await createOrg(overrides.org_id ?? uid('org'));
  await env.DB.prepare(
    `INSERT INTO events (id, org_id, name, slug, type, timezone, starts_at, ends_at,
                         default_submission_limit, agenda_published, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'conference', ?, ?, ?, 3, 0, ?, ?)`,
  ).bind(
    id,
    orgId,
    overrides.name ?? 'Test Event',
    overrides.slug ?? id,
    overrides.timezone ?? 'UTC',
    overrides.starts_at ?? '2026-10-01T08:00:00Z',
    overrides.ends_at ?? '2026-10-02T18:00:00Z',
    ts,
    ts,
  ).run();
  return id;
}

export async function seedContact(
  eventId: string,
  overrides: Partial<{
    id: string; email: string; first_name: string; last_name: string;
    biography: string; company: string; job_title: string; notes: string; headshot_asset_id: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? uid('con');
  const event = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventId).first<{ org_id: string }>();
  if (!event) throw new Error(`seedContact: no event ${eventId}`);
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

/** event_users is (event_id, contact_id, role, invited_at, accepted_at) — no id column. */
export async function seedEventUser(eventId: string, contactId: string, role: Role): Promise<void> {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO event_users (event_id, contact_id, role, invited_at, accepted_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(eventId, contactId, role, ts, ts).run();
}

/** A contact + event_users seat + the cookie header for SELF.fetch. */
export async function seedStaff(
  eventId: string,
  role: Exclude<Role, 'speaker'>,
  // Unique by default: storage is shared inside a test file, and a staff email
  // is exactly what spans events, so a fixed one would leak scope between tests.
  email = `${role}-${crypto.randomUUID().slice(0, 8)}@example.com`,
): Promise<{ contactId: string; cookie: string; email: string }> {
  const contactId = await seedContact(eventId, { email });
  await seedEventUser(eventId, contactId, role);
  const slug = await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>();
  const token = await createSessionToken(
    { contactId, eventId, eventSlug: slug?.slug ?? eventId, email, role },
    env.SESSION_SECRET,
  );
  return { contactId, cookie: `${SESSION_COOKIE}=${token}`, email };
}

export const jsonReq = (cookie: string, body?: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { cookie, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export async function seedSubmission(
  eventId: string,
  overrides: Partial<{ id: string; code: string; title: string; status: string; submitter_contact_id: string; created_at: string }> = {},
): Promise<string> {
  const id = overrides.id ?? uid('sub');
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?)`,
  ).bind(
    id,
    eventId,
    overrides.code ?? `SESS-${id.slice(-6)}`,
    overrides.title ?? 'A talk',
    overrides.status ?? 'pending',
    overrides.submitter_contact_id ?? null,
    overrides.created_at ?? ts,
    ts,
  ).run();
  return id;
}

export async function seedTask(
  eventId: string,
  overrides: Partial<{ id: string; title: string; due_at: string | null; action_type: string }> = {},
): Promise<string> {
  const id = overrides.id ?? uid('tsk');
  await env.DB.prepare(
    `INSERT INTO tasks (id, event_id, title, target, assignment_mode, "trigger", action_type, due_at, required, created_at)
     VALUES (?, ?, ?, 'contact', 'manual', 'none', ?, ?, 0, ?)`,
  ).bind(id, eventId, overrides.title ?? 'Upload slides', overrides.action_type ?? 'acknowledge', overrides.due_at ?? null, ts).run();
  return id;
}

export async function seedFileAsset(
  eventId: string,
  uploadedBy: string | null,
  overrides: Partial<{ id: string; filename: string }> = {},
): Promise<string> {
  const id = overrides.id ?? uid('fa');
  await env.DB.prepare(
    `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
     VALUES (?, ?, ?, ?, 'image/png', 1024, ?, ?)`,
  ).bind(id, eventId, `k/${id}`, overrides.filename ?? 'headshot.png', uploadedBy, ts).run();
  return id;
}

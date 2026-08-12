// Workplan 14 Wave B (decisions D1/D2): organizer-driven contact merge.
//  - POST /app/api/contacts/:id/merge repoints EVERY contact-bearing FK at the
//    winner (the 0015 treatment applied to one pair), resolves event_contacts
//    collisions per the organizer's field picks, tombstones the loser
//    (merged_into, email freed) and writes a contact_merges audit row.
//  - GET /app/api/contacts/duplicates lists candidate pairs in two tiers:
//    same normalized email (strong) and same normalized name (weak).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  jsonReq,
  seedContact,
  seedEvent,
  seedEventUser,
  seedFileAsset,
  seedStaff,
  seedSubmission,
  seedTask,
} from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

/** Every contact-bearing column in the schema (from the migrations). The
 * repoint-completeness assertion sweeps all of them, seeded or not. */
const CONTACT_FK_COLUMNS: ReadonlyArray<[table: string, column: string]> = [
  ['event_users', 'contact_id'],
  ['event_contacts', 'contact_id'],
  ['event_contacts', 'arrival_marked_by'],
  ['portal_accounts', 'contact_id'],
  ['contact_tags', 'contact_id'],
  ['submissions', 'submitter_contact_id'],
  ['submission_participants', 'contact_id'],
  ['review_assignments', 'reviewer_contact_id'],
  ['reviews', 'reviewer_contact_id'],
  ['task_assignments', 'contact_id'],
  ['portal_form_responses', 'contact_id'],
  ['file_request_uploads', 'contact_id'],
  ['file_assets', 'uploaded_by_contact_id'],
  ['message_log', 'contact_id'],
  ['calendar_invites', 'contact_id'],
  ['api_tokens', 'created_by_contact_id'],
  ['auth_tokens', 'contact_id'],
  ['file_comments', 'author_contact_id'],
  ['contact_field_values', 'contact_id'],
  ['evaluation_plan_reviewers', 'contact_id'],
  ['submission_comments', 'author_contact_id'],
  ['chase_drafts', 'contact_id'],
  ['content_revisions', 'edited_by'],
  ['bulk_jobs', 'created_by'],
  ['import_batches', 'created_by'],
];

async function countReferences(contactId: string): Promise<Array<[string, number]>> {
  const out: Array<[string, number]> = [];
  for (const [table, column] of CONTACT_FK_COLUMNS) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .bind(contactId)
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 0) out.push([`${table}.${column}`, row!.n]);
  }
  return out;
}

/** Winner + loser in one org: loser carries rows in a broad spread of FK
 * tables, including collision cases (both people share an event roster, a
 * staff seat, a tag, a participant slot and a task assignment). */
async function seedMergeFixture() {
  const eventA = await seedEvent();
  const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventA).first<{ org_id: string }>();
  const orgId = org!.org_id;
  const eventB = await seedEvent({ org_id: orgId });
  const admin = await seedStaff(eventA, 'admin');

  const winner = await seedContact(eventA, {
    email: 'priya.winner@example.com', first_name: 'Priya', last_name: 'Raman',
    company: 'WinnerCo', biography: 'Winner bio',
  });
  const loser = await seedContact(eventA, {
    email: 'priya.loser@example.com', first_name: 'Priya', last_name: 'Raman',
    company: 'LoserCo', biography: 'Loser bio', job_title: 'CTO',
  });
  // Loser is ALSO on event B (no winner row there → plain repoint of the row).
  await env.DB.prepare(
    `INSERT INTO event_contacts (event_id, contact_id, biography, company, added_at, source)
     VALUES (?, ?, 'B bio', 'BCo', ?, 'admin')`,
  ).bind(eventB, loser, ts).run();

  // event_users collision: loser outranks the winner on event A.
  await seedEventUser(eventA, winner, 'reviewer');
  await seedEventUser(eventA, loser, 'admin');

  // contact_tags collision + loser-only tag. (Storage persists across it()
  // blocks in a file, so every fixed id here is per-fixture unique.)
  const tagShared = uid('tag');
  const tagLoser = uid('tag');
  await env.DB.prepare("INSERT INTO tags (id, event_id, name) VALUES (?, ?, 'VIP')").bind(tagShared, eventA).run();
  await env.DB.prepare("INSERT INTO tags (id, event_id, name) VALUES (?, ?, 'Panelist')").bind(tagLoser, eventA).run();
  await env.DB.prepare('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?), (?, ?)').bind(winner, tagShared, loser, tagLoser).run();
  await env.DB.prepare('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)').bind(loser, tagShared).run();

  // Submissions: loser submitted one, and both are speakers on another.
  const subLoser = await seedSubmission(eventA, { submitter_contact_id: loser, title: 'Loser talk' });
  const subShared = await seedSubmission(eventA, { title: 'Shared talk', status: 'accepted' });
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role) VALUES (?, ?, ?, 'speaker'), (?, ?, ?, 'speaker')`,
  ).bind(uid('sp'), subShared, winner, uid('sp'), subShared, loser).run();
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role) VALUES (?, ?, ?, 'speaker')`,
  ).bind(uid('sp'), subLoser, loser).run();

  // Evaluation: plan, colliding assignment, review, plan-reviewer membership.
  const planId = uid('plan');
  await env.DB.prepare(
    "INSERT INTO evaluation_plans (id, event_id, name, created_at) VALUES (?, ?, 'Round 1', ?)",
  ).bind(planId, eventA, ts).run();
  await env.DB.prepare(
    'INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
  ).bind(uid('ra'), planId, subLoser, winner, uid('ra'), planId, subLoser, loser).run();
  await env.DB.prepare(
    'INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(uid('rev'), subLoser, loser, planId, ts).run();
  await env.DB.prepare(
    'INSERT INTO evaluation_plan_reviewers (plan_id, contact_id, added_at) VALUES (?, ?, ?), (?, ?, ?)',
  ).bind(planId, winner, ts, planId, loser, ts).run();

  // Tasks: colliding assignment on one task, loser-only on another.
  const task1 = await seedTask(eventA);
  const task2 = await seedTask(eventA, { title: 'Confirm bio' });
  await env.DB.prepare(
    'INSERT INTO task_assignments (id, task_id, contact_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
  ).bind(uid('ta'), task1, winner, uid('ta'), task1, loser, uid('ta'), task2, loser).run();

  // Messaging, files, portal, auth, calendar.
  await env.DB.prepare(
    `INSERT INTO message_log (id, event_id, to_email, contact_id, status, idempotency_key, created_at)
     VALUES (?, ?, 'priya.loser@example.com', ?, 'sent', ?, ?)`,
  ).bind(uid('msg'), eventA, loser, uid('idem'), ts).run();
  const asset = await seedFileAsset(eventA, loser);
  const fileRequest = uid('freq');
  await env.DB.prepare(
    "INSERT INTO file_requests (id, event_id, title, type, created_at) VALUES (?, ?, 'Slides', 'contacts', ?)",
  ).bind(fileRequest, eventA, ts).run();
  await env.DB.prepare(
    'INSERT INTO file_request_uploads (id, file_request_id, contact_id, file_asset_id, uploaded_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(uid('fru'), fileRequest, loser, asset, ts).run();
  await env.DB.prepare(
    "INSERT INTO portal_accounts (id, contact_id, created_at) VALUES (?, ?, ?)",
  ).bind(uid('pa'), loser, ts).run();
  await env.DB.prepare(
    "INSERT INTO auth_tokens (token_hash, contact_id, event_id, purpose, created_at, expires_at) VALUES (?, ?, ?, 'portal-login', ?, ?)",
  ).bind(uid('tok'), loser, eventA, ts, '2027-01-01T00:00:00Z').run();
  await env.DB.prepare(
    "INSERT INTO calendar_invites (id, session_id, contact_id, uid) VALUES (?, ?, ?, ?)",
  ).bind(uid('ci'), subShared, loser, uid('uid')).run();
  await env.DB.prepare(
    `INSERT INTO chase_drafts (id, event_id, contact_id, subject_of, subject, body, staged_at, idem_key)
     VALUES (?, ?, ?, 'task', 'Reminder', 'Please…', ?, ?)`,
  ).bind(uid('cd'), eventA, loser, ts, uid('idem')).run();

  // Custom field values: colliding definition on event A.
  const fieldDef = uid('cfd');
  await env.DB.prepare(
    "INSERT INTO contact_field_definitions (id, event_id, key, label, type) VALUES (?, ?, 'tshirt', 'T-shirt', 'text')",
  ).bind(fieldDef, eventA).run();
  await env.DB.prepare(
    "INSERT INTO contact_field_values (contact_id, field_id, value) VALUES (?, ?, 'M'), (?, ?, 'L')",
  ).bind(winner, fieldDef, loser, fieldDef).run();

  return { eventA, eventB, orgId, admin, winner, loser, subLoser, subShared, tagShared, tagLoser, fieldDef };
}

describe('POST /app/api/contacts/:id/merge', () => {
  it('repoints every FK at the winner, resolves collisions, tombstones the loser and writes the audit row', async () => {
    const f = await seedMergeFixture();

    const res = await api(`/contacts/${f.winner}/merge`, f.admin.cookie, {
      loser_id: f.loser,
      fields: { biography: 'loser', job_title: 'loser' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events_affected: number };
    expect(body.ok).toBe(true);
    expect(body.events_affected).toBe(2);

    // Not one reference to the loser survives anywhere in the schema.
    expect(await countReferences(f.loser)).toEqual([]);

    // Collision resolutions:
    // event_users kept ONE row per event, upgraded to the loser's stronger role.
    const seats = await env.DB.prepare('SELECT event_id, role FROM event_users WHERE contact_id = ?')
      .bind(f.winner).all<{ event_id: string; role: string }>();
    expect(seats.results).toEqual([{ event_id: f.eventA, role: 'admin' }]);

    // contact_tags: shared tag deduped, loser-only tag moved over.
    const tags = await env.DB.prepare('SELECT tag_id FROM contact_tags WHERE contact_id = ? ORDER BY tag_id')
      .bind(f.winner).all<{ tag_id: string }>();
    expect(tags.results.map((t) => t.tag_id).sort()).toEqual([f.tagShared, f.tagLoser].sort());

    // submission_participants: one speaker row on the shared talk, loser's own kept.
    const sharedSpeakers = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submission_participants WHERE submission_id = ? AND contact_id = ?',
    ).bind(f.subShared, f.winner).first<{ n: number }>();
    expect(sharedSpeakers?.n).toBe(1);

    // review_assignments deduped per (plan, submission); the loser's review survives.
    const assignments = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM review_assignments WHERE submission_id = ? AND reviewer_contact_id = ?',
    ).bind(f.subLoser, f.winner).first<{ n: number }>();
    expect(assignments?.n).toBe(1);
    const reviews = await env.DB.prepare('SELECT COUNT(*) AS n FROM reviews WHERE reviewer_contact_id = ?')
      .bind(f.winner).first<{ n: number }>();
    expect(reviews?.n).toBe(1);

    // task_assignments: task1 deduped to one row, task2's moved over.
    const taskRows = await env.DB.prepare(
      'SELECT task_id, COUNT(*) AS n FROM task_assignments WHERE contact_id = ? GROUP BY task_id',
    ).bind(f.winner).all<{ task_id: string; n: number }>();
    expect(taskRows.results).toHaveLength(2);
    for (const row of taskRows.results) expect(row.n).toBe(1);

    // contact_field_values: PK collision resolved, winner's own value kept.
    const cfv = await env.DB.prepare(
      'SELECT value FROM contact_field_values WHERE contact_id = ? AND field_id = ?',
    ).bind(f.winner, f.fieldDef).all<{ value: string }>();
    expect(cfv.results).toEqual([{ value: 'M' }]);

    // The tombstone: merged_into set, email freed for future use.
    const tomb = await env.DB.prepare('SELECT email, merged_into FROM contacts WHERE id = ?')
      .bind(f.loser).first<{ email: string; merged_into: string | null }>();
    expect(tomb?.merged_into).toBe(f.winner);
    expect(tomb?.email).not.toBe('priya.loser@example.com');

    // Audit row shape (D1: every repoint recorded).
    const audit = await env.DB.prepare('SELECT * FROM contact_merges WHERE loser_contact_id = ?')
      .bind(f.loser)
      .first<{ org_id: string; winner_contact_id: string; actor: string; field_resolution: string; created_at: string }>();
    expect(audit?.org_id).toBe(f.orgId);
    expect(audit?.winner_contact_id).toBe(f.winner);
    expect(audit?.actor).toBe(f.admin.contactId);
    const resolution = JSON.parse(audit?.field_resolution ?? '{}') as {
      picks: Record<string, string>;
      loser_snapshot: { identity: Record<string, unknown>; events: Array<Record<string, unknown>> };
    };
    expect(resolution.picks).toEqual({ biography: 'loser', job_title: 'loser' });
    expect(resolution.loser_snapshot.identity.email).toBe('priya.loser@example.com');
    expect(resolution.loser_snapshot.events).toHaveLength(2);
  });

  it('merges colliding event_contacts rows per the field picks and repoints loser-only memberships wholesale', async () => {
    const f = await seedMergeFixture();
    const res = await api(`/contacts/${f.winner}/merge`, f.admin.cookie, {
      loser_id: f.loser,
      fields: { biography: 'loser', job_title: 'loser' },
    });
    expect(res.status).toBe(200);

    // Event A collided: biography/job_title picked from the loser, company
    // (unpicked, winner non-blank) keeps the winner's.
    const a = await env.DB.prepare(
      'SELECT biography, company, job_title FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(f.eventA, f.winner).first<{ biography: string | null; company: string | null; job_title: string | null }>();
    expect(a).toEqual({ biography: 'Loser bio', company: 'WinnerCo', job_title: 'CTO' });

    // Event B was loser-only: the row is repointed, its own profile intact.
    const b = await env.DB.prepare(
      'SELECT biography, company FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(f.eventB, f.winner).first<{ biography: string | null; company: string | null }>();
    expect(b).toEqual({ biography: 'B bio', company: 'BCo' });

    // Exactly one membership row per event — the loser's collided row is gone.
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id IN (?, ?)',
    ).bind(f.winner, f.loser).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('removes the loser from the directory, the public feed and the CSV export', async () => {
    const f = await seedMergeFixture();
    // Publish the agenda with the shared talk scheduled so it feeds publicly.
    await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(f.eventA).run();
    await env.DB.prepare(
      "UPDATE submissions SET starts_at = '2026-10-01T09:00:00Z', ends_at = '2026-10-01T10:00:00Z' WHERE id = ?",
    ).bind(f.subShared).run();
    // Give the pair distinguishable names so absence is checkable by string.
    await env.DB.prepare("UPDATE contacts SET first_name = 'Priya', last_name = 'Winner' WHERE id = ?").bind(f.winner).run();
    await env.DB.prepare("UPDATE contacts SET first_name = 'Priya', last_name = 'Loser' WHERE id = ?").bind(f.loser).run();

    const res = await api(`/contacts/${f.winner}/merge`, f.admin.cookie, { loser_id: f.loser, fields: {} });
    expect(res.status).toBe(200);

    // Directory (the Speakers grid's query endpoint).
    const grid = await api('/contacts/query', f.admin.cookie, { from: 0, size: 200, filters: {} });
    const gridBody = (await grid.json()) as { items: Array<{ id: string }> };
    expect(gridBody.items.some((i) => i.id === f.loser)).toBe(false);
    expect(gridBody.items.some((i) => i.id === f.winner)).toBe(true);

    // Org-search (the one contacts read with no event_contacts join).
    const search = await api('/contacts/org-search?q=Priya', f.admin.cookie, undefined, 'GET');
    const searchBody = (await search.json()) as { items: Array<{ id: string }> };
    expect(searchBody.items.some((i) => i.id === f.loser)).toBe(false);

    // Public speakers feed: one Priya, the winner, listed exactly once.
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(f.eventA).first<{ slug: string }>())!.slug;
    const feed = await SELF.fetch(`https://example.com/e/${slug}/speakers.json`);
    expect(feed.status).toBe(200);
    const feedText = await feed.text();
    expect(feedText).toContain('Priya Winner');
    expect(feedText).not.toContain('Priya Loser');
    expect(feedText.match(/Priya Winner/g)).toHaveLength(1);

    // Public agenda XML embed: same story.
    const xmlFeed = await SELF.fetch(`https://example.com/e/${slug}/agenda.xml`);
    expect(xmlFeed.status).toBe(200);
    const xml = await xmlFeed.text();
    expect(xml).toContain('Priya Winner');
    expect(xml).not.toContain('Priya Loser');

    // CSV export.
    const csvRes = await api('/contacts/export?format=csv', f.admin.cookie, undefined, 'GET');
    expect(csvRes.status).toBe(200);
    const csv = await csvRes.text();
    expect(csv).toContain('priya.winner@example.com');
    expect(csv).not.toContain('priya.loser@example.com');
    expect(csv).not.toContain('Loser');
  });

  it('refuses a merge across organisations, into itself, and a repeat merge', async () => {
    const eventA = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const winner = await seedContact(eventA, { email: 'w@example.com' });
    const foreignEvent = await seedEvent(); // its own org
    const foreign = await seedContact(foreignEvent, { email: 'f@example.com' });

    const crossOrg = await api(`/contacts/${winner}/merge`, admin.cookie, { loser_id: foreign });
    expect(crossOrg.status).toBe(404);
    const self = await api(`/contacts/${winner}/merge`, admin.cookie, { loser_id: winner });
    expect(self.status).toBe(400);

    const loser = await seedContact(eventA, { email: 'l@example.com' });
    const first = await api(`/contacts/${winner}/merge`, admin.cookie, { loser_id: loser });
    expect(first.status).toBe(200);
    const again = await api(`/contacts/${winner}/merge`, admin.cookie, { loser_id: loser });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('already_merged');
  });

  it('rejects unknown fields and invalid picks', async () => {
    const eventA = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const winner = await seedContact(eventA, { email: 'w2@example.com' });
    const loser = await seedContact(eventA, { email: 'l2@example.com' });

    const unknown = await api(`/contacts/${winner}/merge`, admin.cookie, {
      loser_id: loser, fields: { notes_internal: 'loser' },
    });
    expect(unknown.status).toBe(400);
    const badPick = await api(`/contacts/${winner}/merge`, admin.cookie, {
      loser_id: loser, fields: { biography: 'both' },
    });
    expect(badPick.status).toBe(400);
    // Nothing was merged by the rejected calls.
    const tomb = await env.DB.prepare('SELECT merged_into FROM contacts WHERE id = ?').bind(loser).first<{ merged_into: string | null }>();
    expect(tomb?.merged_into).toBeNull();
  });

  it('takes identity picks from the loser, email included, without tripping the unique index', async () => {
    const eventA = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const winner = await seedContact(eventA, { email: 'old@example.com', first_name: 'P', last_name: 'R' });
    const loser = await seedContact(eventA, { email: 'preferred@example.com', first_name: 'Priya', last_name: 'Raman' });

    const res = await api(`/contacts/${winner}/merge`, admin.cookie, {
      loser_id: loser,
      fields: { email: 'loser', first_name: 'loser', last_name: 'loser' },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT email, first_name, last_name FROM contacts WHERE id = ?')
      .bind(winner).first<{ email: string; first_name: string; last_name: string }>();
    expect(row).toEqual({ email: 'preferred@example.com', first_name: 'Priya', last_name: 'Raman' });
  });

  it('is forbidden to a reviewer session', async () => {
    const eventA = await seedEvent();
    const reviewer = await seedStaff(eventA, 'reviewer');
    const winner = await seedContact(eventA, { email: 'w3@example.com' });
    const loser = await seedContact(eventA, { email: 'l3@example.com' });
    const res = await api(`/contacts/${winner}/merge`, reviewer.cookie, { loser_id: loser });
    expect(res.status).toBe(403);
  });
});

describe('GET /app/api/contacts/duplicates', () => {
  it('lists same-email pairs as strong and same-name pairs as weak, oldest record first', async () => {
    const eventA = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    // Strong: whitespace/case variants of one address (the 0015 unique index
    // is on lower(email) UN-trimmed, so these can coexist).
    const older = await seedContact(eventA, { email: 'dup@example.com', first_name: 'Dana', last_name: 'Dup' });
    await env.DB.prepare("UPDATE contacts SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(older).run();
    const newer = await seedContact(eventA, { email: ' Dup@Example.com', first_name: 'D', last_name: 'Dup' });
    // Weak: same full name, different addresses.
    const priya1 = await seedContact(eventA, { email: 'priya.1@example.com', first_name: 'Priya', last_name: 'Raman' });
    const priya2 = await seedContact(eventA, { email: 'priya.2@example.com', first_name: 'priya', last_name: 'RAMAN' });

    const res = await api('/contacts/duplicates', admin.cookie, undefined, 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ tier: string; contacts: Array<{ id: string; email: string }> }>;
    };

    const strong = body.items.filter((i) => i.tier === 'strong');
    expect(strong).toHaveLength(1);
    // Oldest first — the suggested winner.
    expect(strong[0].contacts.map((c) => c.id)).toEqual([older, newer]);

    const weak = body.items.filter((i) => i.tier === 'weak');
    const weakIds = weak.map((i) => i.contacts.map((c) => c.id).sort());
    expect(weakIds).toContainEqual([priya1, priya2].sort());
  });

  it('excludes tombstoned contacts from the candidate list', async () => {
    const eventA = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const a = await seedContact(eventA, { email: 'n.1@example.com', first_name: 'Nia', last_name: 'Chen' });
    const b = await seedContact(eventA, { email: 'n.2@example.com', first_name: 'Nia', last_name: 'Chen' });

    const before = await api('/contacts/duplicates', admin.cookie, undefined, 'GET');
    const beforeBody = (await before.json()) as { items: Array<{ tier: string }> };
    expect(beforeBody.items.length).toBeGreaterThan(0);

    const merged = await api(`/contacts/${a}/merge`, admin.cookie, { loser_id: b });
    expect(merged.status).toBe(200);

    const after = await api('/contacts/duplicates', admin.cookie, undefined, 'GET');
    const afterBody = (await after.json()) as { items: Array<{ contacts: Array<{ id: string }> }> };
    expect(afterBody.items.some((i) => i.contacts.some((c) => c.id === b))).toBe(false);
  });
});

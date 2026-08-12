// CNT-01: POST /app/api/tasks wrote only the task *definition*, while the
// admin Tasks grid lists `task_assignments` — so a manual task created from
// the workspace produced zero visible rows and looked like a silent failure.
// These cover the target-expansion the endpoint now does.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

const listTasks = async (cookie: string) => {
  const res = await SELF.fetch(
    'https://example.com/app/api/tasks/query',
    jsonReq(cookie, { from: 0, size: 50, filters: {} }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { items: Array<Record<string, unknown>>; total: number };
};

describe('POST /app/api/tasks with targets', () => {
  it('creates one assignment row per picked contact, visible in the tasks list', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const a = await seedContact(eventId, { email: 'a@example.com', first_name: 'Ada' });
    const b = await seedContact(eventId, { email: 'b@example.com', first_name: 'Bo' });

    const res = await api('/tasks', admin.cookie, {
      title: 'Send headshot',
      target: 'contact',
      assignment_mode: 'manual',
      action_type: 'file_upload',
      assignee_contact_ids: [a, b],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.assignments_created).toBe(2);

    const list = await listTasks(admin.cookie);
    const mine = list.items.filter((i) => i.task_title === 'Send headshot');
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((i) => i.contact_id))).toEqual(new Set([a, b]));
    expect(mine.every((i) => i.status === 'not_started')).toBe(true);
  });

  it('de-duplicates repeated contact ids', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const a = await seedContact(eventId, { email: 'dup@example.com' });

    const res = await api('/tasks', admin.cookie, {
      title: 'Acknowledge code of conduct',
      assignee_contact_ids: [a, a],
    });
    expect((await res.json() as Record<string, unknown>).assignments_created).toBe(1);
  });

  it('assigns a submission task to that submission\'s people', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submitter = await seedContact(eventId, { email: 'submitter@example.com' });
    const co = await seedContact(eventId, { email: 'co@example.com' });
    const submissionId = await seedSubmission(eventId, { submitter_contact_id: submitter });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role) VALUES ('sp-1', ?, ?, 'co-speaker')`,
    ).bind(submissionId, co).run();

    const res = await api('/tasks', admin.cookie, {
      title: 'Upload slides',
      target: 'submission',
      action_type: 'file_upload',
      submission_ids: [submissionId],
    });
    expect(res.status).toBe(201);
    expect((await res.json() as Record<string, unknown>).assignments_created).toBe(2);

    const rows = await env.DB.prepare(
      `SELECT contact_id, submission_id FROM task_assignments WHERE submission_id = ?`,
    ).bind(submissionId).all<{ contact_id: string; submission_id: string }>();
    expect(new Set(rows.results.map((r) => r.contact_id))).toEqual(new Set([submitter, co]));

    const list = await listTasks(admin.cookie);
    expect(list.items.filter((i) => i.task_title === 'Upload slides')).toHaveLength(2);
  });

  it('honours explicitly picked contacts on a submission task', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submitter = await seedContact(eventId, { email: 'sub2@example.com' });
    const other = await seedContact(eventId, { email: 'other@example.com' });
    const submissionId = await seedSubmission(eventId, { submitter_contact_id: submitter });

    const res = await api('/tasks', admin.cookie, {
      title: 'Confirm AV',
      target: 'submission',
      submission_ids: [submissionId],
      assignee_contact_ids: [other],
    });
    expect((await res.json() as Record<string, unknown>).assignments_created).toBe(1);
    const row = await env.DB.prepare(
      `SELECT contact_id FROM task_assignments WHERE submission_id = ?`,
    ).bind(submissionId).first<{ contact_id: string }>();
    expect(row?.contact_id).toBe(other);
  });

  it('still allows a definition-only (automatic) create', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/tasks', admin.cookie, {
      title: 'Sign contract',
      assignment_mode: 'automatic',
      trigger: 'on_accept',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.assignments_created).toBe(0);
    expect(created).toMatchObject({ title: 'Sign contract', trigger: 'on_accept', event_id: eventId });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ?')
      .bind(created.id as string).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('rejects a contact from another event', async () => {
    const eventId = await seedEvent();
    const other = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const foreign = await seedContact(other, { email: 'foreign@example.com' });

    const res = await api('/tasks', admin.cookie, { title: 'Nope', assignee_contact_ids: [foreign] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'reference_not_in_event' });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE event_id = ?')
      .bind(eventId).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('rejects a submission from another event', async () => {
    const eventId = await seedEvent();
    const other = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const foreign = await seedSubmission(other);

    const res = await api('/tasks', admin.cookie, {
      title: 'Nope', target: 'submission', submission_ids: [foreign],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'reference_not_in_event' });
  });

  it('rejects a malformed id array', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/tasks', admin.cookie, { title: 'Nope', assignee_contact_ids: [42] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_assignee_contact_ids' });
  });

  it('keeps PUT and DELETE working on a task that has assignments', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId, { email: 'pd@example.com' });
    const created = (await (await api('/tasks', admin.cookie, {
      title: 'Bio due', assignee_contact_ids: [contactId],
    })).json()) as Record<string, unknown>;

    const updated = await api(`/tasks/${created.id}`, admin.cookie, { title: 'Bio due Friday' }, 'PUT');
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ title: 'Bio due Friday' });
    expect((await listTasks(admin.cookie)).items[0]).toMatchObject({ task_title: 'Bio due Friday' });

    const deleted = await api(`/tasks/${created.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    // ON DELETE CASCADE takes the assignments with it.
    expect((await listTasks(admin.cookie)).total).toBe(0);
  });
});

// CNT-01: named audiences ("all speakers") as an assignment target, expanding
// server-side via messagingAdmin's resolveAudience with requireEmail: false —
// a deliverable is owed even by a contact with no address.
describe('POST /app/api/tasks with an audience', () => {
  /** submitter + participant + a roster-only contact + a no-email participant. */
  const seedSpeakers = async (eventId: string) => {
    const submitter = await seedContact(eventId, { email: 'speaker1@example.com', first_name: 'Priya' });
    const participant = await seedContact(eventId, { email: 'speaker2@example.com', first_name: 'Marcus' });
    // contacts.email is NOT NULL — "no address" is the empty string, which is
    // exactly what the messaging hasEmail filter excludes and tasks keep.
    const noEmail = await seedContact(eventId, { email: '', first_name: 'Nomail' });
    const rosterOnly = await seedContact(eventId, { email: 'roster@example.com', first_name: 'Rae' });
    const submissionId = await seedSubmission(eventId, { submitter_contact_id: submitter, status: 'accepted' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role) VALUES (?, ?, ?, 'speaker')`,
    ).bind(`sp-${submissionId}-1`, submissionId, participant).run();
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role) VALUES (?, ?, ?, 'speaker')`,
    ).bind(`sp-${submissionId}-2`, submissionId, noEmail).run();
    return { submitter, participant, noEmail, rosterOnly, submissionId };
  };

  it('audience: speakers assigns everyone attached to a submission, email or not', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { submitter, participant, noEmail, rosterOnly } = await seedSpeakers(eventId);

    const res = await api('/tasks', admin.cookie, {
      title: 'Upload Session Presentation',
      target: 'contact',
      action_type: 'file_upload',
      audience: 'speakers',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>).assignments_created).toBe(3);

    const rows = await env.DB.prepare(
      `SELECT ta.contact_id FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id WHERE t.event_id = ?`,
    ).bind(eventId).all<{ contact_id: string }>();
    const assigned = new Set(rows.results.map((r) => r.contact_id));
    expect(assigned).toEqual(new Set([submitter, participant, noEmail]));
    expect(assigned.has(rosterOnly)).toBe(false);
  });

  it('merges an audience with explicitly picked ids, de-duplicated', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { submitter, rosterOnly } = await seedSpeakers(eventId);

    const res = await api('/tasks', admin.cookie, {
      title: 'Headshot',
      audience: 'speakers',
      assignee_contact_ids: [submitter, rosterOnly],
    });
    expect(res.status).toBe(201);
    // 3 speakers + rosterOnly; submitter counted once.
    expect(((await res.json()) as Record<string, unknown>).assignments_created).toBe(4);
  });

  it('rejects an unknown audience', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/tasks', admin.cookie, { title: 'Nope', audience: 'sponsors' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_audience' });
  });

  it('GET /tasks/audiences reports task-flavored counts (no email filter)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedSpeakers(eventId);

    const res = await SELF.fetch('https://example.com/app/api/tasks/audiences', {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const { audiences } = (await res.json()) as { audiences: Array<{ audience: string; count: number }> };
    const byName = new Map(audiences.map((a) => [a.audience, a.count]));
    // The no-email participant counts here (unlike the messaging counts).
    expect(byName.get('speakers')).toBe(3);
    expect(byName.get('accepted_speakers')).toBe(3);
    // seedStaff's contact is on the event too: 4 seeded + the admin.
    expect(byName.get('all_contacts')).toBe(5);
  });
});

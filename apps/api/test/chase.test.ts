// Assisted chasing (workplan-13 W4, D5/D6/D7). Four claims under test:
//
//  1. chase_mode='assisted': a sweep that would have sent N emails stages N
//     chase_drafts rows and sends zero; re-running the sweep stages nothing
//     new (idem_key carries exactly today's send key).
//  2. Send queues exactly one message whose outbox payload carries the acting
//     organiser's address in Reply-To (D6), and a second Send 409s.
//  3. The default chase_mode='auto' reproduces the pre-conversion sweep:
//     offsets [7,2,0] produce exactly three sent task reminders (off7, off2,
//     late0 — offset 0 fires as overdue day 0, as it always has) and nothing
//     after the assignment completes (08-communications acceptance test 6).
//  4. Escalate bumps the rung and sends nothing; Dismiss parks the draft and
//     auto mode never resurrects it (D7).
//
// Time is not faked: like bulkjobs-expander-remind.test.ts, due dates are
// seeded relative to Date.now() and moved to walk the offset windows — the
// sweep's arithmetic only ever sees (now - due).

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepReminders } from '../src/jobs/reminders';
import { jsonReq, seedContact, seedEvent, seedStaff, seedTask } from './fixtures-admin';

const DAY_MS = 86_400_000;
const ts = '2026-08-01T00:00:00Z';
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

async function seedAssignment(
  eventId: string,
  contactId: string,
  dueAt: string,
  offsets: number[] = [7, 2, 0],
): Promise<{ taskId: string; assignId: string }> {
  const taskId = await seedTask(eventId, { due_at: dueAt });
  await env.DB.prepare('UPDATE tasks SET reminder_offsets_days = ? WHERE id = ?')
    .bind(JSON.stringify(offsets), taskId)
    .run();
  const assignId = `ta-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, 'not_started')`,
  ).bind(assignId, taskId, contactId).run();
  return { taskId, assignId };
}

const setChaseMode = (eventId: string, mode: string) =>
  env.DB.prepare('UPDATE events SET chase_mode = ? WHERE id = ?').bind(mode, eventId).run();

const draftsFor = async (eventId: string) =>
  (
    await env.DB.prepare('SELECT * FROM chase_drafts WHERE event_id = ? ORDER BY idem_key')
      .bind(eventId)
      .all<{ id: string; contact_id: string; subject_of: string; status: string; rung: string; idem_key: string; subject: string; body: string }>()
  ).results;

const logRowsFor = async (eventId: string) =>
  (
    await env.DB.prepare(
      'SELECT idempotency_key, status, contact_id FROM message_log WHERE event_id = ? ORDER BY idempotency_key',
    )
      .bind(eventId)
      .all<{ idempotency_key: string; status: string; contact_id: string }>()
  ).results;

describe('assisted chasing — staging sweep (W4b, D5)', () => {
  it('stages N drafts and sends zero; a re-run stages nothing new', async () => {
    const eventId = await seedEvent();
    await setChaseMode(eventId, 'assisted');
    const speaker1 = await seedContact(eventId, { email: 'chase-a1@example.com' });
    const speaker2 = await seedContact(eventId, { email: 'chase-a2@example.com' });
    const { assignId: a1 } = await seedAssignment(eventId, speaker1, inMs(6 * DAY_MS));
    const { assignId: a2 } = await seedAssignment(eventId, speaker2, inMs(6 * DAY_MS));
    // A draft-close reminder too: an open form closing tomorrow with an
    // unsubmitted draft sits in the T-2d window, so today it would have
    // queued draft_reminder v2d.
    const formId = `form-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO submission_forms (id, event_id, internal_name, status, close_at, created_at, updated_at)
       VALUES (?, ?, 'CFP', 'open', ?, ?, ?)`,
    ).bind(formId, eventId, inMs(DAY_MS), ts, ts).run();
    const subId = `sub-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO submissions (id, event_id, form_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'abstract', 'Draft talk', 'draft', ?, 'form', ?, ?)`,
    ).bind(subId, eventId, formId, `D-${subId.slice(-6)}`, speaker1, ts, ts).run();

    await sweepReminders(env);

    const drafts = await draftsFor(eventId);
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.status === 'staged')).toBe(true);
    expect(drafts.every((d) => d.rung === 'tool_email')).toBe(true);
    // idem_key carries exactly what today's send key carried.
    const keys = drafts.map((d) => d.idem_key).sort();
    expect(keys).toEqual(
      [
        `task_reminder:${speaker1}:${a1}:voff7`,
        `task_reminder:${speaker2}:${a2}:voff7`,
        `draft_reminder:${speaker1}:${subId}:v2d`,
      ].sort(),
    );
    // Zero emails: nothing in message_log for this event.
    expect(await logRowsFor(eventId)).toHaveLength(0);

    // Idempotent re-run: same three rows, still nothing sent.
    await sweepReminders(env);
    expect(await draftsFor(eventId)).toHaveLength(3);
    expect(await logRowsFor(eventId)).toHaveLength(0);
  });

  it('renders the draft from the template with merge fields applied', async () => {
    const eventId = await seedEvent({ name: 'ChaseCon' });
    await setChaseMode(eventId, 'assisted');
    const speaker = await seedContact(eventId, { email: 'chase-render@example.com', first_name: 'Rosa' });
    await seedAssignment(eventId, speaker, inMs(6 * DAY_MS));

    await sweepReminders(env);

    const [draft] = await draftsFor(eventId);
    expect(draft!.subject).toBe('Reminder: Upload slides — ChaseCon');
    expect(draft!.body).toContain('Hi Rosa,');
    expect(draft!.body).toContain('<strong>Upload slides</strong>');
    expect(draft!.body).not.toContain('{{'); // fully merged at stage time
  });
});

describe('assisted chasing — inbox API (W4c)', () => {
  it('lists staged drafts, Send queues exactly one message with organiser Reply-To, second Send 409s', async () => {
    const eventId = await seedEvent();
    await setChaseMode(eventId, 'assisted');
    const speaker = await seedContact(eventId, { email: 'chase-send@example.com' });
    const { assignId } = await seedAssignment(eventId, speaker, inMs(6 * DAY_MS));
    await sweepReminders(env);
    const staff = await seedStaff(eventId, 'owner');

    const list = await SELF.fetch('https://x/app/api/chase/drafts', { headers: { cookie: staff.cookie } });
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: Array<{ id: string; contact_id: string; status: string }> };
    const mine = items.filter((i) => i.contact_id === speaker);
    expect(mine).toHaveLength(1);

    const send = await SELF.fetch(`https://x/app/api/chase/drafts/${mine[0]!.id}/send`, jsonReq(staff.cookie));
    expect(send.status).toBe(200);
    expect(await send.json()).toEqual({ ok: true, outcome: 'queued' });

    // Exactly one message, keyed by the staged idem_key.
    const logs = await logRowsFor(eventId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.idempotency_key).toBe(`task_reminder:${speaker}:${assignId}:voff7`);

    // The outbox payload carries the acting organiser's Reply-To (D6).
    const outbox = await env.DB.prepare('SELECT payload FROM outbox WHERE idempotency_key = ?')
      .bind(logs[0]!.idempotency_key)
      .first<{ payload: string }>();
    const payload = JSON.parse(outbox!.payload) as { reply_to?: string; to: string };
    expect(payload.reply_to).toBe(staff.email);
    expect(payload.to).toBe('chase-send@example.com');

    // Draft is settled, attributed to the clicker.
    const row = await env.DB.prepare('SELECT status, acted_by FROM chase_drafts WHERE id = ?')
      .bind(mine[0]!.id)
      .first<{ status: string; acted_by: string }>();
    expect(row).toEqual({ status: 'sent', acted_by: staff.contactId });

    // Sending a settled draft is refused, and a later sweep re-stages nothing.
    const again = await SELF.fetch(`https://x/app/api/chase/drafts/${mine[0]!.id}/send`, jsonReq(staff.cookie));
    expect(again.status).toBe(409);
    await sweepReminders(env);
    expect(await logRowsFor(eventId)).toHaveLength(1);
  });

  it('edits a staged draft in place and sends the edited copy; Send all drains the rest', async () => {
    const eventId = await seedEvent();
    await setChaseMode(eventId, 'assisted');
    const s1 = await seedContact(eventId, { email: 'chase-e1@example.com' });
    const s2 = await seedContact(eventId, { email: 'chase-e2@example.com' });
    await seedAssignment(eventId, s1, inMs(6 * DAY_MS));
    await seedAssignment(eventId, s2, inMs(6 * DAY_MS));
    await sweepReminders(env);
    const staff = await seedStaff(eventId, 'admin');

    const drafts = await draftsFor(eventId);
    const edit = await SELF.fetch(
      `https://x/app/api/chase/drafts/${drafts[0]!.id}`,
      jsonReq(staff.cookie, { subject: 'Nudge from a human', body: '<p>Please, slides?</p>' }, 'PATCH'),
    );
    expect(edit.status).toBe(200);

    const sendAll = await SELF.fetch('https://x/app/api/chase/drafts/send-all', jsonReq(staff.cookie, {}));
    expect(sendAll.status).toBe(200);
    expect(await sendAll.json()).toEqual({ ok: true, sent: 2, skipped: 0, total: 2 });

    const logs = await logRowsFor(eventId);
    expect(logs).toHaveLength(2);
    const edited = await env.DB.prepare('SELECT subject FROM message_log WHERE idempotency_key = ?')
      .bind(drafts[0]!.idem_key)
      .first<{ subject: string }>();
    expect(edited!.subject).toBe('Nudge from a human');
  });

  it('Escalate bumps the rung and sends nothing; Dismiss parks the draft for good (D7)', async () => {
    const eventId = await seedEvent();
    await setChaseMode(eventId, 'assisted');
    const speaker = await seedContact(eventId, { email: 'chase-esc@example.com' });
    await seedAssignment(eventId, speaker, inMs(6 * DAY_MS));
    await sweepReminders(env);
    const staff = await seedStaff(eventId, 'owner');
    const [draft] = await draftsFor(eventId);

    const esc = await SELF.fetch(`https://x/app/api/chase/drafts/${draft!.id}/escalate`, jsonReq(staff.cookie, {}));
    expect(esc.status).toBe(200);
    expect(((await esc.json()) as { rung: string }).rung).toBe('personal_email');
    expect(await logRowsFor(eventId)).toHaveLength(0); // recorded, never automated

    const row = await env.DB.prepare('SELECT rung, status, acted_by, acted_at FROM chase_drafts WHERE id = ?')
      .bind(draft!.id)
      .first<{ rung: string; status: string; acted_by: string; acted_at: string | null }>();
    expect(row!.rung).toBe('personal_email');
    expect(row!.status).toBe('staged'); // an escalated chase is still open
    expect(row!.acted_by).toBe(staff.contactId);
    expect(row!.acted_at).not.toBeNull();

    const dismiss = await SELF.fetch(`https://x/app/api/chase/drafts/${draft!.id}/dismiss`, jsonReq(staff.cookie));
    expect(dismiss.status).toBe(200);

    // Back to auto: the sweep must not resurrect or send the dismissed draft.
    await setChaseMode(eventId, 'auto');
    await sweepReminders(env);
    const after = await draftsFor(eventId);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('dismissed');
    expect(await logRowsFor(eventId)).toHaveLength(0);
  });

  it('reads and writes the per-event chase_mode, defaulting to auto (W4d)', async () => {
    const eventId = await seedEvent();
    const staff = await seedStaff(eventId, 'owner');

    const read = await SELF.fetch('https://x/app/api/chase/settings', { headers: { cookie: staff.cookie } });
    expect(await read.json()).toEqual({ chase_mode: 'auto' }); // migration default, no opt-in

    const put = await SELF.fetch(
      'https://x/app/api/chase/settings',
      jsonReq(staff.cookie, { chase_mode: 'assisted' }, 'PUT'),
    );
    expect(await put.json()).toEqual({ ok: true, chase_mode: 'assisted' });

    const bad = await SELF.fetch(
      'https://x/app/api/chase/settings',
      jsonReq(staff.cookie, { chase_mode: 'yolo' }, 'PUT'),
    );
    expect(bad.status).toBe(400);
  });

  it('requires an authenticated staff session', async () => {
    const res = await SELF.fetch('https://x/app/api/chase/drafts');
    expect(res.status).toBe(401);
  });
});

describe('auto mode reproduces the pre-conversion sweep (D5, 08-communications acceptance 6)', () => {
  it('offsets [7,2,0] produce exactly three sent reminders and none after completion', async () => {
    const eventId = await seedEvent(); // chase_mode stays the 'auto' default
    const speaker = await seedContact(eventId, { email: 'chase-auto@example.com' });
    const { taskId, assignId } = await seedAssignment(eventId, speaker, inMs(6 * DAY_MS));
    const moveDue = (ms: number) =>
      env.DB.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').bind(inMs(ms), taskId).run();

    // T-6d: inside the 7-day window → off7, once.
    await sweepReminders(env);
    await sweepReminders(env);
    let logs = await logRowsFor(eventId);
    expect(logs.map((l) => l.idempotency_key)).toEqual([`task_reminder:${speaker}:${assignId}:voff7`]);

    // T-1d: inside the 2-day window → off2.
    await moveDue(1 * DAY_MS);
    await sweepReminders(env);
    // T+1h: overdue day 0 → late0 (how offset 0 has always fired).
    await moveDue(-3_600_000);
    await sweepReminders(env);

    logs = await logRowsFor(eventId);
    expect(logs.map((l) => l.idempotency_key).sort()).toEqual(
      [
        `task_reminder:${speaker}:${assignId}:voff7`,
        `task_reminder:${speaker}:${assignId}:voff2`,
        `task_reminder:${speaker}:${assignId}:vlate0`,
      ].sort(),
    );
    // Same status the pre-conversion sweep left: queued for the outbox sweep.
    expect(logs.every((l) => l.status === 'queued')).toBe(true);

    // Every auto send is also visible as a settled draft (one pipeline, D5).
    const drafts = await draftsFor(eventId);
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.status === 'sent')).toBe(true);

    // Completion ends the chase: no further reminder, however often it runs.
    await env.DB.prepare(`UPDATE task_assignments SET status = 'complete' WHERE id = ?`).bind(assignId).run();
    await moveDue(-2 * DAY_MS); // deep in the overdue window
    await sweepReminders(env);
    expect(await logRowsFor(eventId)).toHaveLength(3);
  });

  it('still honours OVERDUE_CAP: overdue nudges stop after three', async () => {
    const eventId = await seedEvent();
    const speaker = await seedContact(eventId, { email: 'chase-cap@example.com' });
    const { taskId, assignId } = await seedAssignment(eventId, speaker, inMs(-1 * DAY_MS), []);
    const moveDue = (ms: number) =>
      env.DB.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').bind(inMs(ms), taskId).run();

    for (const daysLate of [1, 2, 3, 4, 5]) {
      await moveDue(-daysLate * DAY_MS - 3_600_000);
      await sweepReminders(env);
    }
    const logs = await logRowsFor(eventId);
    // late0 never fired (due_at started a day late); the cap of 3 admits
    // overdue days 0-2, so only late1 and late2 land.
    expect(logs.map((l) => l.idempotency_key).sort()).toEqual([
      `task_reminder:${speaker}:${assignId}:vlate1`,
      `task_reminder:${speaker}:${assignId}:vlate2`,
    ]);
  });
});

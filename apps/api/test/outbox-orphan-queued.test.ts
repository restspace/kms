// The stalled-invite defect found on the live demo, 2026-08-16.
//
// message_log and outbox are two INSERT OR IGNORE gates on one idempotency
// key. They agree in a healthy installation, so the log gate is the one that
// decides. The demo reset broke that: it replays seed.sql, whose leading
// DELETEs cascade message_log away, while outbox — which the seed never
// mentions — kept every row ever written. Seeded ids are deterministic, so the
// next `Send confirmations` regenerated a key outbox already held as 'done',
// its enqueue no-opped, and the fresh message_log row sat at 'queued' for
// ever: five schedule_confirmed invites, undeliverable and unretryable (the
// Messages tab's retry is gated to 'failed').
//
// Two halves, both tested here: mailer.ts reconciles the tables when they
// disagree ('duplicate', no phantom row), and demo.ts stops them diverging in
// the first place. The third test is the guard that the first two did not buy
// this by weakening NFR-11.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { resetDemoData } from '../src/demo';
import { prepareTemplated, queueTemplated } from '../src/mailer';
import { createContact, createEvent } from './fixtures';

const reminderContext = {
  event: { name: 'Test Event' },
  speaker: { first_name: 'Ada' },
  task: { title: 'Upload slides', due_line: '', url: 'https://app.example.com/portal/evt/tasks' },
};

describe('an outbox row whose message_log row was deleted underneath it', () => {
  it('reports duplicate instead of leaving a message queued for ever', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'orphan@example.com' });
    const args = {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'orphan@example.com',
      entityId: 'assignment-orphan',
      context: reminderContext,
    };

    const first = await queueTemplated(env.DB, args);
    expect(first.outcome).toBe('queued');

    // Exactly what the seed replay does to this pair: the ledger row goes, the
    // queue row stays. (Delivered, so the sweep will never touch it again.)
    await env.DB.prepare(`UPDATE outbox SET status = 'done' WHERE idempotency_key LIKE 'task_reminder:%'`).run();
    await env.DB.prepare(`DELETE FROM message_log WHERE to_email = 'orphan@example.com'`).run();

    const second = await queueTemplated(env.DB, args);
    expect(second.outcome).toBe('duplicate');

    // The point of the fix: no row claiming to be on its way when nothing is.
    const stranded = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE to_email = 'orphan@example.com' AND status = 'queued'`,
    ).first<{ n: number }>();
    expect(stranded?.n).toBe(0);
  });

  it('holds for the batch path too, which commits both inserts in one D1 batch', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'orphan-batch@example.com' });
    const args = {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'orphan-batch@example.com',
      entityId: 'assignment-orphan-batch',
      context: reminderContext,
    };

    const prepared = await prepareTemplated(env.DB, args);
    expect(prepared).not.toBeNull();
    await env.DB.batch(prepared!.statements);

    await env.DB.prepare(`UPDATE outbox SET status = 'done' WHERE idempotency_key = ?`).bind(prepared!.logKey).run();
    await env.DB.prepare(`DELETE FROM message_log WHERE to_email = 'orphan-batch@example.com'`).run();

    // null means "nothing to send", so the caller adds no statements at all.
    expect(await prepareTemplated(env.DB, args)).toBeNull();
  });
});

describe('resetDemoData', () => {
  it('clears the outbox, so a replayed seed cannot inherit stale keys', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'pre-reset@example.com' });
    await queueTemplated(env.DB, {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'pre-reset@example.com',
      entityId: 'assignment-pre-reset',
      context: reminderContext,
    });
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>();
    expect(before?.n).toBeGreaterThan(0);

    await resetDemoData(env.DB);

    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});

describe('NFR-11 is intact', () => {
  it('still refuses to send the same key twice while both tables agree', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'once@example.com' });
    const args = {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'once@example.com',
      entityId: 'assignment-once',
      context: reminderContext,
    };

    expect((await queueTemplated(env.DB, args)).outcome).toBe('queued');
    expect((await queueTemplated(env.DB, args)).outcome).toBe('duplicate');
    expect((await queueTemplated(env.DB, args)).outcome).toBe('duplicate');

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE to_email = 'once@example.com'`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('lets a deliberate re-send through, because it bumps the version', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'resend@example.com' });
    const args = {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'resend@example.com',
      entityId: 'assignment-resend',
      context: reminderContext,
    };

    expect((await queueTemplated(env.DB, { ...args, version: 0 })).outcome).toBe('queued');
    // What scheduleMail.ts does on every schedule change (ICS SEQUENCE).
    expect((await queueTemplated(env.DB, { ...args, version: 1 })).outcome).toBe('queued');
  });
});

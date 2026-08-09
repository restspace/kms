// Workers regression test for the OutgoingEmail/OutboxEmailPayload change
// needed by sweep item P2-20 (packages/email/src/index.ts gained an optional
// `log_key` so providers can read it). jobs/outbox.ts discriminated its
// payload union on `'log_key' in payload`, which stopped working once
// `log_key` became a legal (optional) key on both union members — this test
// guards that the sweep still delivers a message_log-backed email end to end
// via the `typeof payload.log_key === 'string'` narrowing fix.

import { env } from 'cloudflare:test';
import { createDb } from '@kms/db';
import { describe, expect, it } from 'vitest';
import { sweepOutbox } from '../src/jobs/outbox';
import { queueTemplated } from '../src/mailer';
import { createContact, createEvent } from './fixtures';

describe('sweepOutbox with the shared OutgoingEmail.log_key field', () => {
  it('delivers a queueTemplated email and marks message_log sent (console provider in DEV_MODE)', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'sink@example.com' });

    const { outcome } = await queueTemplated(env.DB, {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'sink@example.com',
      entityId: 'assignment-1',
      context: {
        event: { name: 'Test Event' },
        speaker: { first_name: 'Ada' },
        task: { title: 'Upload slides', due_line: '', url: 'https://app.example.com/portal/evt/tasks' },
      },
    });
    expect(outcome).toBe('queued');

    const db = createDb(env.DB);
    await sweepOutbox(db, env, env.DB);

    const row = await env.DB.prepare(`SELECT status FROM message_log WHERE template_key = 'task_reminder' AND to_email = 'sink@example.com'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('sent');
  });

  it('does not re-deliver an already-sent message on a second sweep tick', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId, { email: 'sink2@example.com' });
    await queueTemplated(env.DB, {
      templateKey: 'task_reminder',
      eventId,
      contactId,
      toEmail: 'sink2@example.com',
      entityId: 'assignment-2',
      context: {
        event: { name: 'Test Event' },
        speaker: { first_name: 'Ada' },
        task: { title: 'Upload slides', due_line: '', url: 'https://app.example.com/portal/evt/tasks' },
      },
    });
    const db = createDb(env.DB);
    await sweepOutbox(db, env, env.DB);
    const first = await env.DB.prepare(`SELECT provider_message_id FROM message_log WHERE to_email = 'sink2@example.com'`)
      .first<{ provider_message_id: string }>();

    await sweepOutbox(db, env, env.DB); // nothing left claimable — no-op
    const second = await env.DB.prepare(`SELECT provider_message_id FROM message_log WHERE to_email = 'sink2@example.com'`)
      .first<{ provider_message_id: string }>();
    expect(second?.provider_message_id).toBe(first?.provider_message_id);
  });
});

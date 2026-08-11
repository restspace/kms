// Demo deployments seed contacts with reserved example.com addresses, which
// Resend refuses with a 422 — on the live demo every reminder/decision email
// retried to death and sent/Notified counters stayed at zero (observed in the
// 2026-08-11 CNT eval as "Remind all → internal_error" then "0 sent").
// deliverEmail now simulates delivery for example.* recipients when
// DEMO_RESET=on, without touching a provider; real addresses still go out.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deliverEmail, queueTemplated } from '../src/mailer';
import { createContact, createEvent } from './fixtures';

const reminderContext = {
  event: { name: 'Test Event' },
  speaker: { first_name: 'Ada' },
  task: { title: 'Upload slides', due_line: '', url: 'https://app.example.com/portal/evt/tasks' },
};

async function queueTo(toEmail: string, entityId: string) {
  const eventId = await createEvent();
  const contactId = await createContact(eventId, { email: toEmail });
  const { outcome, payload } = await queueTemplated(env.DB, {
    templateKey: 'task_reminder',
    eventId,
    contactId,
    toEmail,
    entityId,
    context: reminderContext,
  });
  expect(outcome).toBe('queued');
  return payload!;
}

describe('deliverEmail demo-mode simulation', () => {
  it('marks an example.com recipient sent without a provider when DEMO_RESET=on', async () => {
    const payload = await queueTo('ada@example.com', 'assignment-demo-1');
    // No DEV_MODE console provider and no API keys: any real provider path
    // would fail, so success proves the simulation branch handled it.
    const demoEnv = { ...env, DEMO_RESET: 'on', DEV_MODE: '', RESEND_API_KEY: undefined, SENDGRID_API_KEY: undefined };
    await deliverEmail(env.DB, demoEnv, payload);
    const row = await env.DB.prepare(
      `SELECT status, provider_message_id FROM message_log WHERE idempotency_key = ?`,
    )
      .bind(payload.log_key)
      .first<{ status: string; provider_message_id: string }>();
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('demo-simulated');
  });

  it('still delivers non-example recipients through the provider when DEMO_RESET=on', async () => {
    const payload = await queueTo('real.person@atelyr.com', 'assignment-demo-2');
    const demoEnv = { ...env, DEMO_RESET: 'on' }; // DEV_MODE console provider stays active
    await deliverEmail(env.DB, demoEnv, payload);
    const row = await env.DB.prepare(
      `SELECT status, provider_message_id FROM message_log WHERE idempotency_key = ?`,
    )
      .bind(payload.log_key)
      .first<{ status: string; provider_message_id: string }>();
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).not.toBe('demo-simulated');
  });

  it('does not simulate outside demo mode', async () => {
    const payload = await queueTo('ada2@example.com', 'assignment-demo-3');
    const plainEnv = { ...env, DEMO_RESET: '' }; // DEV_MODE console provider delivers
    await deliverEmail(env.DB, plainEnv, payload);
    const row = await env.DB.prepare(
      `SELECT provider_message_id FROM message_log WHERE idempotency_key = ?`,
    )
      .bind(payload.log_key)
      .first<{ provider_message_id: string }>();
    expect(row?.provider_message_id).not.toBe('demo-simulated');
  });
});

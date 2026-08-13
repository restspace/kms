// Workplan 15 W3 (D5/D6/D7): "revise and resubmit" as a third decision
// outcome, stored as a flag on a row that stays declined — submissions.status
// carries a CHECK from 0001_init.sql that SQLite cannot widen without
// rebuilding a table 14 others reference, so the vocabulary lives in an
// exported set validated in the route (the 0026 precedent).
//
// The plan's cases:
//  1. A revise row sends decision_revise and never decision_declined.
//  2. The merged summary carries three blocks in the right order.
//  3. A returning contact sees their guidance; a first-time submitter sees
//     nothing.
//  4. resubmission_of survives the round trip.
//  5. The export's derived `outcome` column reads revise_requested where
//     `status` reads declined (D6 — the honest cost of D5).
//
// Storage is NOT isolated between it() blocks; every assertion is scoped to
// ids created within its own test.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { seedForm, submitBodyV2 } from './fixtures-submission';

const ts = '2026-08-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

async function settleJob(jobId: string) {
  await sweepBulkJobs(env, 50);
  for (let i = 0; i < 50; i++) {
    const row = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string }>();
    if (row && row.status !== 'pending' && row.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`bulk job ${jobId} never settled`);
}

async function staffSession(eventId: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  return sessionCookieFor({ contactId, eventId, eventSlug: eventId, role: 'admin' });
}

async function seedSubmission(
  eventId: string,
  submitterId: string | null,
  status: string,
  overrides: Partial<{ title: string; decision_outcome: string; revise_guidance: string }> = {},
): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source,
       decision_outcome, revise_guidance, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?, ?, ?)`,
  ).bind(
    id,
    eventId,
    `SESS-${id.slice(-6)}`,
    overrides.title ?? `Talk ${id.slice(-4)}`,
    status,
    submitterId,
    overrides.decision_outcome ?? null,
    overrides.revise_guidance ?? null,
    ts,
    ts,
  ).run();
  return id;
}

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

async function payloadFor(jobId: string, keyLike: string): Promise<{ template: string; html: string }> {
  const msg = await env.DB.prepare(
    `SELECT template_key, idempotency_key FROM message_log WHERE bulk_job_id = ? AND idempotency_key LIKE ?`,
  )
    .bind(jobId, keyLike)
    .first<{ template_key: string; idempotency_key: string }>();
  if (!msg) throw new Error(`no message_log row matching ${keyLike}`);
  const outboxRow = await env.DB.prepare('SELECT payload FROM outbox WHERE idempotency_key = ?')
    .bind(msg.idempotency_key)
    .first<{ payload: string }>();
  if (!outboxRow) throw new Error(`no outbox row for key ${msg.idempotency_key}`);
  return { template: msg.template_key, html: (JSON.parse(outboxRow.payload) as { html: string }).html };
}

describe('revise and resubmit (workplan 15 W3)', () => {
  it('1. "Ask to revise" leaves the row in the decline queue, and the send uses decision_revise', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'rev1@example.com', first_name: 'Ada' });
    const id = await seedSubmission(eventId, speaker, 'decline_queue', { title: 'Nearly there' });

    const flagged = await SELF.fetch('https://example.com/app/api/submissions/bulk-decision', post(cookie, {
      ids: [id],
      decision_outcome: 'revise',
      revise_guidance: 'Cut the vendor section and add two production numbers.',
    }));
    expect(flagged.status).toBe(200);

    // D5's whole point: the status machine is untouched.
    const flaggedRow = await env.DB.prepare('SELECT status, decision_outcome FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ status: string; decision_outcome: string | null }>();
    expect(flaggedRow?.status).toBe('decline_queue');
    expect(flaggedRow?.decision_outcome).toBe('revise');

    const res = await SELF.fetch('https://example.com/app/api/submissions/send-decisions', post(cookie, { ids: [id] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const sent = await payloadFor(body.job_id, `%:${id}:v%`);
    expect(sent.template).toBe('decision_revise');
    expect(sent.html).toContain('Cut the vendor section');

    // And never the plain rejection, for this job.
    const declines = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE bulk_job_id = ? AND template_key = 'decision_declined'`,
    )
      .bind(body.job_id)
      .first<{ n: number }>();
    expect(declines?.n).toBe(0);

    // It still flipped to declined, because it is one.
    const after = await env.DB.prepare('SELECT status FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ status: string }>();
    expect(after?.status).toBe('declined');
  });

  it('2. the merged summary carries three blocks: accepts, declines, then revises', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'rev2@example.com', first_name: 'Grace' });
    const accept = await seedSubmission(eventId, speaker, 'accept_queue', { title: 'Talk Accepted One' });
    const decline = await seedSubmission(eventId, speaker, 'decline_queue', { title: 'Talk Declined One' });
    const revise = await seedSubmission(eventId, speaker, 'decline_queue', {
      title: 'Talk Revise One',
      decision_outcome: 'revise',
      revise_guidance: 'Narrow it to one case study.',
    });

    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/send-decisions',
      post(cookie, { ids: [accept, decline, revise] }),
    );
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const messages = await env.DB.prepare('SELECT template_key FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .all<{ template_key: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]!.template_key).toBe('decision_summary');

    const { html } = await payloadFor(body.job_id, '%:batch:%');
    const iAccept = html.indexOf('Talk Accepted One');
    const iDecline = html.indexOf('Talk Declined One');
    const iRevise = html.indexOf('Talk Revise One');
    expect(iAccept).toBeGreaterThan(-1);
    expect(iDecline).toBeGreaterThan(iAccept);
    expect(iRevise).toBeGreaterThan(iDecline);
    expect(html).toContain('Revise and resubmit');
    // The guidance is what makes a revise line worth having.
    expect(html).toContain('Narrow it to one case study.');
  });

  it('3. a returning contact sees their guidance on next year\'s form; a first-time submitter sees nothing', async () => {
    const form = await seedForm();
    const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?')
      .bind(form.eventId)
      .first<{ org_id: string }>();
    // D7: the lookup is org-scoped, across events — the guidance was given at
    // LAST year's event and is never copied onto this one.
    const priorEventId = await createEvent({ org_id: org!.org_id, name: 'Prior Year' });
    const prior = await seedSubmission(priorEventId, form.submitterId, 'declined', {
      title: 'Last year’s proposal',
      decision_outcome: 'revise',
      revise_guidance: 'Bring production numbers and drop the vendor pitch.',
    });

    const page = await SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });
    const html = await page.text();
    expect(html).toContain('Bring production numbers and drop the vendor pitch.');
    expect(html).toContain('Last year’s proposal');
    expect(html).toContain(prior);

    // A submitter with no history sees no panel at all.
    const stranger = await createContact(form.eventId, { email: `fresh-${crypto.randomUUID()}@example.com` });
    const strangerCookie = await sessionCookieFor({
      contactId: stranger,
      eventId: form.eventId,
      eventSlug: form.eventSlug,
    });
    const cleanPage = await SELF.fetch(`https://example.com${form.basePath}`, {
      headers: { cookie: strangerCookie },
    });
    const cleanHtml = await cleanPage.text();
    expect(cleanHtml).not.toContain('Bring production numbers');
    expect(cleanHtml).toContain('"revise_invites":[]');
  });

  it('4. resubmission_of survives the draft round trip and the promote to a real submission', async () => {
    const form = await seedForm();
    const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?')
      .bind(form.eventId)
      .first<{ org_id: string }>();
    const priorEventId = await createEvent({ org_id: org!.org_id, name: 'Prior Year' });
    const prior = await seedSubmission(priorEventId, form.submitterId, 'declined', {
      decision_outcome: 'revise',
      revise_guidance: 'Add numbers.',
    });

    const draftRes = await SELF.fetch(
      `https://example.com${form.basePath}/draft`,
      post(form.cookie, { submission_id: null, answers: {}, force_new: true, resubmission_of: prior }),
    );
    expect(draftRes.status).toBe(200);
    const draft = (await draftRes.json()) as { submission_id: string };
    const stamped = await env.DB.prepare('SELECT resubmission_of FROM submissions WHERE id = ?')
      .bind(draft.submission_id)
      .first<{ resubmission_of: string | null }>();
    expect(stamped?.resubmission_of).toBe(prior);

    // Promoting the draft leaves the lineage alone.
    const submitted = await SELF.fetch(
      `https://example.com${form.basePath}/submit`,
      post(form.cookie, { ...submitBodyV2(form, 'The revised talk'), submission_id: draft.submission_id }),
    );
    expect(submitted.status).toBe(200);
    const promoted = await env.DB.prepare('SELECT status, resubmission_of FROM submissions WHERE id = ?')
      .bind(draft.submission_id)
      .first<{ status: string; resubmission_of: string | null }>();
    expect(promoted?.status).toBe('pending');
    expect(promoted?.resubmission_of).toBe(prior);

    // A prior id that is not this contact's revise row is refused, not trusted.
    const foreign = await seedSubmission(priorEventId, null, 'declined');
    const bogus = await SELF.fetch(
      `https://example.com${form.basePath}/draft`,
      post(form.cookie, { submission_id: null, answers: {}, force_new: true, resubmission_of: foreign }),
    );
    const bogusBody = (await bogus.json()) as { submission_id: string };
    const bogusRow = await env.DB.prepare('SELECT resubmission_of FROM submissions WHERE id = ?')
      .bind(bogusBody.submission_id)
      .first<{ resubmission_of: string | null }>();
    expect(bogusRow?.resubmission_of).toBeNull();
  });

  it('5. the export\'s derived outcome column reads revise_requested where status reads declined (D6)', async () => {
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'rev5@example.com' });
    const revise = await seedSubmission(eventId, speaker, 'declined', {
      title: 'Revise me',
      decision_outcome: 'revise',
      revise_guidance: 'Tighten it.',
    });
    const declined = await seedSubmission(eventId, speaker, 'declined', { title: 'Plain decline' });
    const accepted = await seedSubmission(eventId, speaker, 'accepted', { title: 'Plain accept' });

    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/export?format=csv&event_id=${eventId}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    const header = csv.split('\r\n')[0]!.replace('﻿', '').split(',');
    const idIdx = header.indexOf('id');
    const statusIdx = header.indexOf('status');
    const outcomeIdx = header.indexOf('outcome');
    expect(outcomeIdx).toBeGreaterThan(-1);

    const rows = new Map<string, string[]>();
    for (const line of csv.split('\r\n').slice(1)) {
      if (!line) continue;
      const cells = line.split(',');
      rows.set(cells[idIdx]!, cells);
    }
    // The reader of the CSV must not have to know about D5's storage
    // compromise: status still says declined, outcome says what happened.
    expect(rows.get(revise)![statusIdx]).toBe('declined');
    expect(rows.get(revise)![outcomeIdx]).toBe('revise_requested');
    expect(rows.get(declined)![outcomeIdx]).toBe('declined');
    expect(rows.get(accepted)![outcomeIdx]).toBe('accepted');
  });

  it('6. the outcome vocabulary is validated in the route, not by a CHECK', async () => {
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'rev6@example.com' });
    const id = await seedSubmission(eventId, speaker, 'decline_queue');

    const bad = await SELF.fetch(`https://example.com/app/api/submissions/${id}/decision`, {
      ...post(cookie, { decision_outcome: 'maybe' }),
      method: 'PUT',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('invalid_decision_outcome');
  });
});

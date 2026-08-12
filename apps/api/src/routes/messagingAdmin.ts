// Organiser-triggered messaging surfaces that don't fit adminApi.ts's
// generic CRUD tables. Lives in its own file (like filesAdmin.ts) and mounts
// at /app/api/messaging from app.ts, immediately after the /app/api mount so
// the shared admin guard still runs first. The guard is re-resolved
// defensively below so this router is correct even if the mount order ever
// changes (same convention as filesAdmin.ts).
//
// Currently covers SPK-06 (portal invitation): an organiser inviting a known
// contact into their speaker portal via the same magic-link seam every other
// sign-in link uses (docs/03 §5, docs/08 §3) — message_log + outbox, so a
// missing provider queues/fails visibly instead of erroring the request.

import { Hono } from 'hono';
import { can } from '@kms/core';
import { createDb } from '@kms/db';
import { DEFAULT_TEMPLATES } from '@kms/email';
import type { Actor } from '@kms/core';
import type { AccessEnv } from '../access';
import { getRevalidatedPrivilegedSession } from '../session';
import { deliverEmail, renderTemplatedPreview, sendTemplated, type OutboxEmailPayload } from '../mailer';
import { sweepBulkJobs } from '../jobs/bulkJobs';
import { mintToken, sha256hex } from '../tokens';

export const messagingAdminRoutes = new Hono<AccessEnv>();

messagingAdminRoutes.use('*', async (c, next) => {
  if (!c.get('session')) {
    const session = await getRevalidatedPrivilegedSession(c);
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
    if (!can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
    c.set('session', session);
  }
  await next();
});

interface ContactRow {
  id: string;
  email: string;
}

/**
 * POST /app/api/messaging/invite-portal { contact_id }
 *
 * Mints a portal-login token for an existing contact in the current event
 * and sends it through the same `magic_link` template/seam `/auth/request`
 * uses, so status lands in message_log exactly like every other send (no
 * separate success path to keep in sync, no bespoke provider handling).
 * Idempotency key is the token hash (mirrors requestMagicLink) — a caller
 * retrying the request mints a fresh token/link each time by design; the
 * dedupe guarantee mailer.ts provides is "one send per token", not "one
 * invite per contact".
 */
messagingAdminRoutes.post('/invite-portal', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  if (!contactId) return c.json({ error: 'contact_id_required' }, 400);

  const db = c.env.DB;
  const [event, contact] = await Promise.all([
    db.prepare('SELECT id, name FROM events WHERE id = ?').bind(session.eventId).first<{ id: string; name: string }>(),
    db
      // 0015: the join to event_contacts is the tenancy guard the old
      // `contacts.event_id` was — a contact who exists in the org but is not
      // on this event yields no row, so the invite 404s rather than minting a
      // portal-login token for another event's speaker.
      .prepare(
        `SELECT c.id, c.email
           FROM contacts c
           JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
          WHERE c.id = ?`,
      )
      .bind(session.eventId, contactId)
      .first<ContactRow>(),
  ]);
  if (!event) return c.json({ error: 'not_found' }, 404);
  if (!contact) return c.json({ error: 'contact_not_found' }, 404);

  const { raw: token, statement } = await mintToken(db, {
    contactId: contact.id,
    eventId: session.eventId,
    purpose: 'portal-login',
  });
  await statement.run();
  const hash = await sha256hex(token);
  const origin = c.env.DEV_MODE === 'on' ? new URL(c.req.url).origin : c.env.APP_URL;
  const link = `${origin}/auth/callback?t=${token}`;

  const outcome = await sendTemplated(c, {
    templateKey: 'magic_link',
    eventId: session.eventId,
    contactId: contact.id,
    toEmail: contact.email,
    entityId: hash,
    context: { event: { name: event.name }, magic_link: link },
  });

  // Mirrors the reviewer sign-in-link endpoint's contract (evaluation.ts):
  // hand the organiser the actual link alongside triggering the email, so
  // they can verify or share it themselves without needing the speaker's
  // inbox — e.g. to preview/impersonate the portal as that speaker. The
  // link is bound to this contact by construction (minted against
  // `contact.id` above), so surfacing it here can never leak someone else's.
  return c.json({ ok: true, outcome, link });
});

// ---------------------------------------------------------------------------
// SPK-13: organiser compose. The Messages tab was read-only history — there
// was no way to write to speakers from the workspace at all. Rather than
// inventing a second sending path, a compose snapshots its (subject, body,
// resolved recipient ids) into a `bulk_jobs` row exactly like send-decisions
// does, and the cron expander (jobs/bulkJobs.ts, kind 'compose') renders the
// body per recipient through the normal merge-field/theme/message_log/outbox
// machinery. The organiser therefore gets the same live sent/failed counts
// from `GET /app/api/bulk-jobs/:id` and the same per-recipient audit trail in
// the Messages tab, for free.
// ---------------------------------------------------------------------------

/**
 * Merge fields a composed message may use. Also served to the UI (compose
 * hint + the Settings → Email templates card) so the documented list and the
 * context the expander actually builds cannot drift apart.
 */
export const COMPOSE_MERGE_FIELDS: ReadonlyArray<{ field: string; description: string }> = [
  { field: 'first_name', description: 'Recipient first name (falls back to "there")' },
  { field: 'last_name', description: 'Recipient last name' },
  { field: 'full_name', description: 'First + last name, or the email address' },
  { field: 'email', description: 'Recipient email address' },
  { field: 'company', description: 'Recipient company' },
  { field: 'job_title', description: 'Recipient job title' },
  { field: 'event.name', description: 'Event name' },
  { field: 'portal_url', description: 'Link to the speaker portal' },
];

export type ComposeAudience = 'all_contacts' | 'roster' | 'speakers' | 'accepted_speakers' | 'selected';

const COMPOSE_AUDIENCES: readonly ComposeAudience[] = [
  'all_contacts',
  'roster',
  'speakers',
  'accepted_speakers',
  'selected',
];

export interface ComposeRecipient {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  job_title: string | null;
}

/**
 * Resolve an audience to a de-duplicated list of contacts in this event.
 *
 *  - `all_contacts`      every contact on the event with an email
 *  - `roster`            every contact on the event with an email and a name —
 *                        the full roster reachable regardless of whether
 *                        they're linked to a submission, so a contact added
 *                        to the event but never attached to a session (who
 *                        `speakers` below cannot see) is still reachable by
 *                        name rather than only through `all_contacts` or a
 *                        manual multi-select
 *  - `speakers`          anyone attached to a submission (submitter or a
 *                        `submission_participants` row) — the workspace's
 *                        working definition of "speaker"
 *  - `accepted_speakers` the same, narrowed to accepted submissions
 *  - `selected`          exactly the ids the organiser checked, filtered to
 *                        this event (a foreign id is dropped rather than
 *                        erroring: the selection may come from a stale grid)
 *
 * Resolution happens once, at compose time, and the ids are frozen into the
 * job — the same snapshot discipline expandSendDecisions uses, so a contact
 * created while the job drains doesn't silently join the send.
 *
 * `opts.requireEmail` (default true) keeps the messaging behaviour: someone
 * without an address cannot be emailed, so compose drops them. Task
 * assignment (CNT-01) resolves the same audiences with `requireEmail: false`
 * — an assignee needn't be reachable by email to owe a deliverable, and the
 * portal shows the task either way.
 */
export async function resolveAudience(
  db: D1Database,
  eventId: string,
  audience: ComposeAudience,
  contactIds: string[],
  opts: { requireEmail?: boolean } = {},
): Promise<ComposeRecipient[]> {
  // 0015: `contacts` is org-level identity, `event_contacts` is membership AND
  // the per-event profile. The join therefore does both jobs every audience
  // here needs — it is the "on this event" filter that `contacts.event_id`
  // used to be, and it is where company/job_title come from, so the merge
  // fields carry the recipient's title at THIS event rather than another
  // event's in the same org.
  const select = `SELECT c.id, c.email, c.first_name, c.last_name, ec.company, ec.job_title
       FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id`;
  const hasEmail = opts.requireEmail === false ? '1=1' : "c.email IS NOT NULL AND TRIM(c.email) != ''";
  // Contacts-hygiene item 4: a contact staked out by the public submission
  // wizard's Account step (submit.tsx) before any name is collected — or
  // left over from a form that never collects one — can end up on the roster
  // with a blank name on both columns. That stub is not someone to message;
  // excluded here the same way the Speakers grid's default view excludes it
  // (App.tsx's isPlaceholderContact).
  const hasName = "TRIM(COALESCE(c.first_name, '') || COALESCE(c.last_name, '')) != ''";
  if (audience === 'selected') {
    if (contactIds.length === 0) return [];
    const placeholders = contactIds.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`${select} WHERE ec.event_id = ? AND c.id IN (${placeholders}) AND ${hasEmail} ORDER BY c.id`)
      .bind(eventId, ...contactIds)
      .all<ComposeRecipient>();
    return results;
  }
  if (audience === 'all_contacts') {
    const { results } = await db
      .prepare(`${select} WHERE ec.event_id = ? AND ${hasEmail} ORDER BY c.id`)
      .bind(eventId)
      .all<ComposeRecipient>();
    return results;
  }
  if (audience === 'roster') {
    const { results } = await db
      .prepare(`${select} WHERE ec.event_id = ? AND ${hasEmail} AND ${hasName} ORDER BY c.id`)
      .bind(eventId)
      .all<ComposeRecipient>();
    return results;
  }
  const statusClause = audience === 'accepted_speakers' ? "AND s.status = 'accepted'" : '';
  const { results } = await db
    .prepare(
      `${select} WHERE ec.event_id = ?1 AND ${hasEmail} AND ${hasName} AND c.id IN (
         SELECT s.submitter_contact_id FROM submissions s
          WHERE s.event_id = ?1 AND s.submitter_contact_id IS NOT NULL ${statusClause}
         UNION
         SELECT p.contact_id FROM submission_participants p
           JOIN submissions s ON s.id = p.submission_id
          WHERE s.event_id = ?1 ${statusClause}
       ) ORDER BY c.id`,
    )
    .bind(eventId)
    .all<ComposeRecipient>();
  return results;
}

/**
 * The compose textarea holds plain text; template bodies are HTML fragments
 * (the theme wrapper supplies the document). Convert once, at compose time:
 * escape the organiser's text so a stray `<` cannot become markup, then turn
 * blank lines into paragraphs and single newlines into `<br>` so the message
 * reads the way it was typed.
 *
 * `{{merge.fields}}` survive escaping untouched (no HTML-special characters),
 * and their *values* are escaped separately by renderTemplate's merge
 * transform — so the two escapes compose correctly rather than double-encoding.
 */
export function composeBodyToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .split(/\r?\n\s*\r?\n/)
    .map((para) => para.trim())
    .filter((para) => para !== '')
    .map((para) => `<p>${para.replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * POST /app/api/messaging/compose
 *   { subject, body, audience?, contact_ids?: string[] } → 202 { job_id, total }
 *
 * Snapshot-and-return: no provider work happens in-request. `total` is the
 * resolved recipient count, so the UI can say what it is about to do before
 * the first poll of `GET /app/api/bulk-jobs/:id` comes back.
 */
messagingAdminRoutes.post('/compose', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
  if (!subject) return c.json({ error: 'subject_required' }, 400);
  if (!messageBody) return c.json({ error: 'body_required' }, 400);

  const contactIds = Array.isArray(body.contact_ids)
    ? body.contact_ids.filter((v): v is string => typeof v === 'string')
    : [];
  const requested = typeof body.audience === 'string' ? body.audience : contactIds.length > 0 ? 'selected' : '';
  if (!COMPOSE_AUDIENCES.includes(requested as ComposeAudience)) return c.json({ error: 'audience_invalid' }, 400);
  const audience = requested as ComposeAudience;

  const recipients = await resolveAudience(db, session.eventId, audience, contactIds);
  if (recipients.length === 0) return c.json({ error: 'no_recipients' }, 400);

  const jobId = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
       VALUES (?, ?, 'compose', 'pending', ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      jobId,
      session.eventId,
      JSON.stringify({
        subject,
        body: composeBodyToHtml(messageBody),
        body_text: messageBody,
        contact_ids: recipients.map((r) => r.id),
        // Email snapshot per recipient (2026-08-12 sweep, defects 2/3): if a
        // recipient drops off the event roster before the expander reaches
        // them, this is what lets the expander still write an accounted-for
        // 'failed' log row instead of silently sending to fewer people than
        // the button said.
        emails: Object.fromEntries(recipients.map((r) => [r.id, r.email])),
      }),
      recipients.length,
      session.contactId,
      ts,
      ts,
    )
    .run();

  // Same dead-minute fix as dashboard /remind and send-decisions: expand the
  // job now via waitUntil so the compose progress toast sees real counts
  // instead of "0/N queued" until the next cron tick.
  try {
    c.executionCtx.waitUntil(sweepBulkJobs(c.env));
  } catch {
    await sweepBulkJobs(c.env); // environments without an execution context (tests)
  }

  return c.json({ ok: true, job_id: jobId, total: recipients.length, audience }, 202);
});

/**
 * GET /app/api/messaging/compose/audiences — recipient counts per audience,
 * so the compose form can label each option with what it will actually reach
 * instead of making the organiser guess.
 */
messagingAdminRoutes.get('/compose/audiences', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const items = await Promise.all(
    (['all_contacts', 'roster', 'speakers', 'accepted_speakers'] as const).map(async (audience) => ({
      audience,
      count: (await resolveAudience(db, session.eventId, audience, [])).length,
    })),
  );
  return c.json({ items, merge_fields: COMPOSE_MERGE_FIELDS });
});

/**
 * POST /app/api/messaging/preview { subject, body, contact_id } →
 *   { subject, body_text, body_html }
 *
 * Workplan-14 F2/D3: a compose could only be verified by actually sending
 * it. This renders the exact same (subject, body) pair for one recipient
 * through `renderTemplatedPreview` (mailer.ts) — the identical override →
 * theme → `renderTemplate` steps `expandCompose` runs before `queueTemplated`
 * writes message_log — so nothing here can drift from what a real send would
 * produce. The recipient context (first_name/company/portal_url/…) is built
 * the same way `expandCompose` builds it (jobs/bulkJobs.ts); compose has no
 * first-class "template" concept to pick from (the organiser always supplies
 * ad-hoc subject/body), so there is no template picker here — see D3's "if
 * more than one template matches the context" clause, which is N/A for this
 * flow.
 */
messagingAdminRoutes.post('/preview', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const subject = typeof body.subject === 'string' ? body.subject : '';
  const messageBody = typeof body.body === 'string' ? body.body : '';
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  if (!subject.trim()) return c.json({ error: 'subject_required' }, 400);
  if (!messageBody.trim()) return c.json({ error: 'body_required' }, 400);
  if (!contactId) return c.json({ error: 'contact_id_required' }, 400);

  const [event, recipients] = await Promise.all([
    db.prepare('SELECT id, name, slug FROM events WHERE id = ?').bind(session.eventId).first<{ id: string; name: string; slug: string }>(),
    // `resolveAudience('selected', …)` is the same event_contacts-scoped
    // lookup `compose` and `expandCompose` use — a contact not on this event
    // (or on someone else's event entirely) resolves to no rows, same
    // tenancy guard as every other route here.
    resolveAudience(db, session.eventId, 'selected', [contactId]),
  ]);
  if (!event) return c.json({ error: 'not_found' }, 404);
  const recipient = recipients[0];
  if (!recipient) return c.json({ error: 'contact_not_found' }, 404);

  // Mirrors expandCompose's recipientContext exactly (jobs/bulkJobs.ts) so a
  // preview and the message that later lands in message_log are built from
  // the same inputs, not just rendered by the same function.
  const fullName = [recipient.first_name, recipient.last_name].filter(Boolean).join(' ') || recipient.email;
  const recipientContext = {
    first_name: recipient.first_name ?? 'there',
    last_name: recipient.last_name ?? '',
    full_name: fullName,
    email: recipient.email,
    company: recipient.company ?? '',
    job_title: recipient.job_title ?? '',
  };
  const rendered = await renderTemplatedPreview(db, {
    templateKey: 'compose',
    eventId: session.eventId,
    template: { subject, body: composeBodyToHtml(messageBody) },
    context: {
      ...recipientContext,
      speaker: recipientContext,
      contact: recipientContext,
      event: { name: event.name },
      portal_url: `${c.env.APP_URL}/portal/${event.slug}`,
    },
  });
  if (!rendered) return c.json({ error: 'template_disabled' }, 409);
  return c.json(rendered);
});

/**
 * POST /app/api/messaging/messages/:id/retry — re-queue one failed message.
 *
 * 2026-08-12 eval sweep, defect 3: a 'failed' row in the Messages tab (the
 * outbox dead-lettered it after MAX_ATTEMPTS) had no affordance at all — the
 * organiser could see the failure but do nothing about it. Retry revives the
 * dead outbox row (or rebuilds it from the 0029 stored body when the outbox
 * row is gone), flips the log row back to 'queued', and attempts delivery
 * inline so the response carries the real outcome; if the inline attempt
 * fails the normal outbox sweep owns the backoff/retries from there.
 */
messagingAdminRoutes.post('/messages/:id/retry', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const id = c.req.param('id');
  const msg = await db
    .prepare(
      `SELECT id, status, idempotency_key, to_email, subject, body_html, body_text
       FROM message_log WHERE id = ? AND event_id = ?`,
    )
    .bind(id, session.eventId)
    .first<{
      id: string; status: string; idempotency_key: string; to_email: string;
      subject: string | null; body_html: string | null; body_text: string | null;
    }>();
  if (!msg) return c.json({ error: 'not_found' }, 404);
  if (msg.status !== 'failed') return c.json({ error: 'not_failed' }, 409);

  const outboxRow = await db
    .prepare('SELECT id, payload FROM outbox WHERE idempotency_key = ?')
    .bind(msg.idempotency_key)
    .first<{ id: string; payload: string }>();

  let payload: OutboxEmailPayload;
  const ts = new Date().toISOString();
  if (outboxRow) {
    // The dead-lettered row still carries the exact payload that failed —
    // resend that, byte for byte, with the attempt counter reset so it gets
    // a full backoff sequence again rather than dying on the first miss.
    payload = JSON.parse(outboxRow.payload) as OutboxEmailPayload;
    await db
      .prepare(`UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ?`)
      .bind(ts, outboxRow.id)
      .run();
  } else if (msg.body_html || msg.body_text) {
    payload = {
      to: msg.to_email,
      subject: msg.subject ?? '',
      html: msg.body_html ?? '',
      text: msg.body_text ?? msg.body_html ?? '',
      log_key: msg.idempotency_key,
    };
    await createDb(db).outbox.enqueue({ kind: 'email', idempotencyKey: msg.idempotency_key, payload });
  } else {
    // Pre-0029 row with no outbox row left: nothing stores what the message
    // said, so there is nothing faithful to resend.
    return c.json({ error: 'not_retryable' }, 409);
  }

  await db.prepare(`UPDATE message_log SET status = 'queued', error = NULL WHERE id = ?`).bind(id).run();

  // Inline attempt through the same claim lease the sweep uses (mirrors
  // sendTemplated's fast path), but awaited so the response reports the real
  // outcome instead of an optimistic "queued".
  const claimed = await db
    .prepare(
      `UPDATE outbox SET status = 'in_flight', next_attempt_at = ?
       WHERE idempotency_key = ? AND status = 'pending'
       RETURNING id`,
    )
    .bind(new Date(Date.now() + 5 * 60_000).toISOString(), msg.idempotency_key)
    .first<{ id: string }>();
  if (claimed) {
    try {
      await deliverEmail(db, c.env, payload);
      await createDb(db).outbox.markDoneByKey(msg.idempotency_key);
    } catch (err) {
      // deliverEmail already recorded the error on message_log; count the
      // attempt toward the normal backoff so the sweep takes over.
      await createDb(db).outbox.markFailed(claimed.id, err instanceof Error ? err.message : String(err));
    }
  }

  const after = await db
    .prepare('SELECT status, error, sent_at FROM message_log WHERE id = ?')
    .bind(id)
    .first<{ status: string; error: string | null; sent_at: string | null }>();
  return c.json({ ok: true, status: after?.status ?? 'queued', error: after?.error ?? null, sent_at: after?.sent_at ?? null });
});

// ---------------------------------------------------------------------------
// SPK-14: template visibility. `email_templates` overrides have driven every
// send since docs/08 but had no UI — the only way to reword a system email
// was SQL. These two routes are the whole surface: list the code defaults
// alongside whatever this event overrides, and upsert/clear one override.
// ---------------------------------------------------------------------------

interface TemplateOverrideRow {
  key: string;
  subject: string | null;
  body_richtext: string | null;
  enabled: number;
  updated_at: string;
}

/** GET /app/api/messaging/templates → defaults + this event's overrides. */
messagingAdminRoutes.get('/templates', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB.prepare(
    'SELECT key, subject, body_richtext, enabled, updated_at FROM email_templates WHERE event_id = ?',
  )
    .bind(session.eventId)
    .all<TemplateOverrideRow>();
  const byKey = new Map(results.map((r) => [r.key, r]));

  // DEFAULT_TEMPLATES is the canonical key list; an override for a key that
  // no longer ships as a default would otherwise be invisible *and*
  // un-clearable, so any extra keys are appended rather than dropped.
  const keys = [
    ...Object.keys(DEFAULT_TEMPLATES),
    ...results.map((r) => r.key).filter((k) => !(k in DEFAULT_TEMPLATES)),
  ];
  const items = keys.map((key) => {
    const override = byKey.get(key);
    const fallback = DEFAULT_TEMPLATES[key];
    return {
      key,
      default_subject: fallback?.subject ?? null,
      default_body: fallback?.body ?? null,
      subject: override?.subject ?? null,
      body_richtext: override?.body_richtext ?? null,
      enabled: override ? override.enabled : 1,
      overridden: Boolean(override && (override.subject || override.body_richtext || override.enabled === 0)),
      updated_at: override?.updated_at ?? null,
    };
  });
  return c.json({ items, merge_fields: COMPOSE_MERGE_FIELDS });
});

/**
 * PUT /app/api/messaging/templates/:key { subject?, body_richtext?, enabled? }
 *
 * Upsert of one per-event override. An empty string clears that half of the
 * override and the code default takes over again (renderTemplate already
 * treats empty as absent) — that is what the card's "Reset" sends. Keys are
 * restricted to the shipped defaults: an override for an unknown key would
 * never render, so accepting one only creates dead rows.
 */
messagingAdminRoutes.put('/templates/:key', async (c) => {
  const session = c.get('session');
  const key = c.req.param('key');
  if (!(key in DEFAULT_TEMPLATES)) return c.json({ error: 'unknown_template' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const norm = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const subject = norm(body.subject);
  const bodyRichtext = norm(body.body_richtext);
  const enabled = body.enabled === false || body.enabled === 0 ? 0 : 1;
  const ts = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO email_templates (id, event_id, key, name, subject, body_richtext, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id, key) DO UPDATE SET
       subject = excluded.subject,
       body_richtext = excluded.body_richtext,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(crypto.randomUUID(), session.eventId, key, key, subject, bodyRichtext, enabled, ts)
    .run();

  return c.json({
    ok: true,
    key,
    subject,
    body_richtext: bodyRichtext,
    enabled,
    overridden: Boolean(subject || bodyRichtext || enabled === 0),
    updated_at: ts,
  });
});

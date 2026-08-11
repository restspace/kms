// Assisted chasing (workplan-13 W4, decisions D5/D6/D7). Two halves:
//
//  1. The staging seam the reminder sweep calls (`stageChase`): every
//     would-be reminder send becomes a `chase_drafts` row whose idem_key is
//     exactly the message_log key today's send would have used, so the
//     no-double-nudge guarantee lives at the staging step. In the default
//     chase_mode='auto' the same call then sends the staged draft through
//     queueTemplated — byte for byte today's behaviour, same template, same
//     context, same idempotency. In 'assisted' it stops at 'staged'.
//
//  2. The chase-inbox API (`chaseRoutes`, mounted at /app/api/chase from
//     app.ts after the shared admin guard, same convention as
//     messagingAdmin.ts): list staged drafts, edit subject/body in place,
//     Send (queueTemplated with the acting organiser's address in Reply-To —
//     D6), Send all, Dismiss, and Escalate (bumps `rung`, sends nothing,
//     records when — D7: the higher rungs happen outside the tool).

import { Hono } from 'hono';
import { can } from '@kms/core';
import type { Actor } from '@kms/core';
import { DEFAULT_TEMPLATES, escapeHtml, mergeVariables, type TemplateOverride } from '@kms/email';
import type { AccessEnv } from './access';
import { queueTemplated } from './mailer';
import { getRevalidatedPrivilegedSession } from './session';

export const CHASE_MODES = new Set(['auto', 'assisted']);

/** Escalation ladder, lowest first (D7). Only recorded, never automated. */
export const CHASE_RUNGS = ['tool_email', 'personal_email', 'cc_chair', 'text', 'call'] as const;

export interface ChaseStageArgs {
  templateKey: string;
  /** what is being chased — mirrors chase_drafts.subject_of */
  subjectOf: 'task' | 'draft_close';
  /** the entity id today's send key carries (assignment id, submission id) */
  subjectId: string;
  /** offset / overdue-day index — the version segment of today's send key */
  version: string;
  eventId: string;
  contactId: string;
  toEmail: string;
  /** events.chase_mode; anything but 'assisted' behaves as 'auto' (default) */
  chaseMode: string | null;
  context: Record<string, unknown>;
}

/**
 * Render subject + pre-theme body fragment for staging. Mirrors
 * renderTemplate's override resolution (DB row wins when non-empty, code
 * default otherwise, enabled=0 disables) but stops before the theme wrapper:
 * the stored draft is the editable fragment, and the theme is applied at send
 * time exactly like every other message.
 */
async function renderStageFragment(
  db: D1Database,
  eventId: string,
  templateKey: string,
  context: Record<string, unknown>,
): Promise<{ subject: string; body: string } | null> {
  const override = await db
    .prepare('SELECT subject, body_richtext, enabled FROM email_templates WHERE event_id = ? AND key = ?')
    .bind(eventId, templateKey)
    .first<TemplateOverride>();
  if (override && override.enabled === 0) return null; // explicitly disabled
  const fallback = DEFAULT_TEMPLATES[templateKey];
  const subjectSource = override?.subject || fallback?.subject;
  const bodySource = override?.body_richtext || fallback?.body;
  if (!subjectSource || !bodySource) return null;
  return {
    subject: mergeVariables(subjectSource, context).replace(/[\r\n]+/g, ' '),
    body: mergeVariables(bodySource, context, escapeHtml),
  };
}

/**
 * The sweep's replacement for a direct queueTemplated call (W4b). Stages a
 * chase_drafts row keyed by today's send key; in auto mode immediately sends
 * the STAGED draft via the original template/context so message_log and the
 * outbox carry exactly what they carry today. A row that is already 'sent'
 * or 'dismissed' is never re-sent — re-running the sweep is free.
 */
export async function stageChase(db: D1Database, args: ChaseStageArgs): Promise<void> {
  const idemKey = `${args.templateKey}:${args.contactId}:${args.subjectId}:v${args.version}`;
  const rendered = await renderStageFragment(db, args.eventId, args.templateKey, args.context);
  // Template disabled for the event: today's sweep queues nothing; stage
  // nothing either, so switching modes cannot resurrect a silenced reminder.
  if (!rendered) return;

  await db
    .prepare(
      `INSERT OR IGNORE INTO chase_drafts
         (id, event_id, contact_id, subject_of, subject_id, subject, body, staged_at, idem_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.eventId,
      args.contactId,
      args.subjectOf,
      args.subjectId,
      rendered.subject,
      rendered.body,
      new Date().toISOString(),
      idemKey,
    )
    .run();

  if (args.chaseMode === 'assisted') return;

  // Auto (the default, D5): the sweep that staged the draft sends it in the
  // same pass. Only a still-staged row sends — a draft dismissed during an
  // assisted stint stays dismissed after a switch back to auto.
  const draft = await db
    .prepare('SELECT id, status FROM chase_drafts WHERE idem_key = ?')
    .bind(idemKey)
    .first<{ id: string; status: string }>();
  if (!draft || draft.status !== 'staged') return;

  // The original args, verbatim — same override resolution, theme, context
  // and message_log key as the pre-conversion sweep. 'duplicate' means the
  // mail already went out (e.g. before this table existed): mark sent, don't
  // resend — the mailer's INSERT OR IGNORE stays the last line of defence.
  await queueTemplated(db, {
    templateKey: args.templateKey,
    eventId: args.eventId,
    contactId: args.contactId,
    toEmail: args.toEmail,
    entityId: args.subjectId,
    version: args.version,
    context: args.context,
  });
  await db
    .prepare(`UPDATE chase_drafts SET status = 'sent', acted_at = ? WHERE id = ? AND status = 'staged'`)
    .bind(new Date().toISOString(), draft.id)
    .run();
}

// ---------------------------------------------------------------------------
// The chase-inbox API (W4c). Admin/owner only: the shared /app/api guard
// already 403s reviewer seats off non-review surfaces; the defensive
// middleware below keeps this router correct if the mount order ever changes
// (same convention as messagingAdmin.ts / filesAdmin.ts).
// ---------------------------------------------------------------------------

export const chaseRoutes = new Hono<AccessEnv>();

chaseRoutes.use('*', async (c, next) => {
  if (!c.get('session')) {
    const session = await getRevalidatedPrivilegedSession(c);
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
    if (!can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
    c.set('session', session);
  }
  await next();
});

interface ChaseDraftRow {
  id: string;
  event_id: string;
  contact_id: string;
  subject_of: string;
  subject_id: string | null;
  rung: string;
  status: string;
  subject: string;
  body: string;
  staged_at: string;
  acted_at: string | null;
  acted_by: string | null;
  idem_key: string;
  contact_email: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
}

const DRAFT_STATUSES = new Set(['staged', 'sent', 'dismissed', 'resolved']);

async function loadDraft(db: D1Database, id: string, eventId: string): Promise<ChaseDraftRow | null> {
  return db
    .prepare(
      `SELECT cd.*, c.email AS contact_email, c.first_name AS contact_first_name, c.last_name AS contact_last_name
       FROM chase_drafts cd
       JOIN contacts c ON c.id = cd.contact_id
       WHERE cd.id = ? AND cd.event_id = ?`,
    )
    .bind(id, eventId)
    .first<ChaseDraftRow>();
}

const draftJson = (d: ChaseDraftRow) => ({
  id: d.id,
  contact_id: d.contact_id,
  contact_email: d.contact_email,
  contact_name:
    `${d.contact_first_name ?? ''} ${d.contact_last_name ?? ''}`.trim() || d.contact_email || d.contact_id,
  subject_of: d.subject_of,
  subject_id: d.subject_id,
  rung: d.rung,
  status: d.status,
  subject: d.subject,
  body: d.body,
  staged_at: d.staged_at,
  acted_at: d.acted_at,
  acted_by: d.acted_by,
});

/**
 * Deliver one draft through queueTemplated with the organiser's Reply-To
 * (D6). The draft's stored (possibly edited) subject/body ride as an inline
 * template — the same seam the compose flow uses — and the idem_key's parts
 * are replayed so message_log's key is exactly the staged one: a reminder
 * already sent under auto mode dedupes instead of double-nudging.
 */
async function deliverDraft(
  db: D1Database,
  draft: ChaseDraftRow,
  actor: { contactId: string; email: string },
): Promise<'queued' | 'duplicate' | 'no_email'> {
  if (!draft.contact_email) return 'no_email';
  // idem_key = `${templateKey}:${contactId}:${entityId}:v${version}` — ids in
  // this schema are UUIDs and never contain ':'. A manual/foreign key shape
  // falls back to a per-draft key rather than failing the send.
  const parts = draft.idem_key.split(':');
  const [templateKey, , entityId, versionSeg] =
    parts.length === 4 ? parts : ['chase_manual', draft.contact_id, draft.id, 'v1'];
  const event = await db
    .prepare('SELECT name FROM events WHERE id = ?')
    .bind(draft.event_id)
    .first<{ name: string }>();

  const { outcome } = await queueTemplated(db, {
    templateKey: templateKey!,
    eventId: draft.event_id,
    contactId: draft.contact_id,
    toEmail: draft.contact_email,
    entityId: entityId!,
    version: versionSeg!.replace(/^v/, ''),
    replyTo: actor.email,
    // Stored drafts are fully merged at stage time; the context only feeds
    // the theme wrapper's header/footer.
    context: { event: { name: event?.name ?? '' } },
    template: { subject: draft.subject, body: draft.body },
  });
  await db
    .prepare(`UPDATE chase_drafts SET status = 'sent', acted_at = ?, acted_by = ? WHERE id = ? AND status = 'staged'`)
    .bind(new Date().toISOString(), actor.contactId, draft.id)
    .run();
  return outcome === 'duplicate' ? 'duplicate' : 'queued';
}

/**
 * GET /app/api/chase/drafts?status=staged&contact_id=…
 * Current event's drafts, newest speakers' first-staged order — sorted by
 * contact so the inbox groups by speaker without a second query.
 */
chaseRoutes.get('/drafts', async (c) => {
  const session = c.get('session');
  const status = c.req.query('status') ?? 'staged';
  if (!DRAFT_STATUSES.has(status)) return c.json({ error: 'status_invalid' }, 400);
  const contactId = c.req.query('contact_id');

  const { results } = await c.env.DB.prepare(
    `SELECT cd.*, c.email AS contact_email, c.first_name AS contact_first_name, c.last_name AS contact_last_name
     FROM chase_drafts cd
     JOIN contacts c ON c.id = cd.contact_id
     WHERE cd.event_id = ? AND cd.status = ?${contactId ? ' AND cd.contact_id = ?' : ''}
     ORDER BY c.last_name, c.first_name, cd.contact_id, cd.staged_at`,
  )
    .bind(...(contactId ? [session.eventId, status, contactId] : [session.eventId, status]))
    .all<ChaseDraftRow>();

  return c.json({ items: results.map(draftJson) });
});

/** PATCH /app/api/chase/drafts/:id { subject?, body? } — edit while staged. */
chaseRoutes.patch('/drafts/:id', async (c) => {
  const session = c.get('session');
  const draft = await loadDraft(c.env.DB, c.req.param('id'), session.eventId);
  if (!draft) return c.json({ error: 'not_found' }, 404);
  if (draft.status !== 'staged') return c.json({ error: 'not_staged' }, 409);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const subject = typeof body.subject === 'string' && body.subject.trim() !== '' ? body.subject.trim() : draft.subject;
  const draftBody = typeof body.body === 'string' && body.body.trim() !== '' ? body.body : draft.body;

  await c.env.DB.prepare(`UPDATE chase_drafts SET subject = ?, body = ? WHERE id = ? AND status = 'staged'`)
    .bind(subject, draftBody, draft.id)
    .run();
  return c.json({ ok: true, item: draftJson({ ...draft, subject, body: draftBody }) });
});

/** POST /app/api/chase/drafts/:id/send — queue with organiser Reply-To (D6). */
chaseRoutes.post('/drafts/:id/send', async (c) => {
  const session = c.get('session');
  const draft = await loadDraft(c.env.DB, c.req.param('id'), session.eventId);
  if (!draft) return c.json({ error: 'not_found' }, 404);
  if (draft.status !== 'staged') return c.json({ error: 'not_staged' }, 409);

  const outcome = await deliverDraft(c.env.DB, draft, session);
  if (outcome === 'no_email') return c.json({ error: 'contact_has_no_email' }, 422);
  return c.json({ ok: true, outcome });
});

/**
 * POST /app/api/chase/drafts/send-all { contact_id? } — the 40-staged-nudges
 * case: one click, still hers. Skips (and reports) contacts without an email.
 */
chaseRoutes.post('/drafts/send-all', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : null;

  const { results } = await c.env.DB.prepare(
    `SELECT cd.*, c.email AS contact_email, c.first_name AS contact_first_name, c.last_name AS contact_last_name
     FROM chase_drafts cd
     JOIN contacts c ON c.id = cd.contact_id
     WHERE cd.event_id = ? AND cd.status = 'staged'${contactId ? ' AND cd.contact_id = ?' : ''}
     ORDER BY cd.staged_at`,
  )
    .bind(...(contactId ? [session.eventId, contactId] : [session.eventId]))
    .all<ChaseDraftRow>();

  let sent = 0;
  let skipped = 0;
  for (const draft of results) {
    const outcome = await deliverDraft(c.env.DB, draft, session);
    if (outcome === 'no_email') skipped += 1;
    else sent += 1;
  }
  return c.json({ ok: true, sent, skipped, total: results.length });
});

/** POST /app/api/chase/drafts/:id/dismiss — staged → dismissed, no send. */
chaseRoutes.post('/drafts/:id/dismiss', async (c) => {
  const session = c.get('session');
  const draft = await loadDraft(c.env.DB, c.req.param('id'), session.eventId);
  if (!draft) return c.json({ error: 'not_found' }, 404);
  if (draft.status !== 'staged') return c.json({ error: 'not_staged' }, 409);

  await c.env.DB.prepare(
    `UPDATE chase_drafts SET status = 'dismissed', acted_at = ?, acted_by = ? WHERE id = ? AND status = 'staged'`,
  )
    .bind(new Date().toISOString(), session.contactId, draft.id)
    .run();
  return c.json({ ok: true });
});

/**
 * POST /app/api/chase/drafts/:id/escalate { rung? } — bump the ladder (next
 * rung when omitted), send nothing, record when (D7). The row stays staged:
 * escalation is a note on an open chase, not a resolution.
 */
chaseRoutes.post('/drafts/:id/escalate', async (c) => {
  const session = c.get('session');
  const draft = await loadDraft(c.env.DB, c.req.param('id'), session.eventId);
  if (!draft) return c.json({ error: 'not_found' }, 404);
  if (draft.status !== 'staged') return c.json({ error: 'not_staged' }, 409);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  let rung: string;
  if (typeof body.rung === 'string') {
    if (!(CHASE_RUNGS as readonly string[]).includes(body.rung)) return c.json({ error: 'rung_invalid' }, 400);
    rung = body.rung;
  } else {
    const next = CHASE_RUNGS[CHASE_RUNGS.indexOf(draft.rung as (typeof CHASE_RUNGS)[number]) + 1];
    if (!next) return c.json({ error: 'rung_max' }, 409);
    rung = next;
  }

  const ts = new Date().toISOString();
  await c.env.DB.prepare(`UPDATE chase_drafts SET rung = ?, acted_at = ?, acted_by = ? WHERE id = ?`)
    .bind(rung, ts, session.contactId, draft.id)
    .run();
  return c.json({ ok: true, rung, acted_at: ts });
});

/** GET /app/api/chase/settings — the current event's chase_mode (W4d). */
chaseRoutes.get('/settings', async (c) => {
  const session = c.get('session');
  const row = await c.env.DB.prepare('SELECT chase_mode FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ chase_mode: string | null }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ chase_mode: row.chase_mode ?? 'auto' });
});

/** PUT /app/api/chase/settings { chase_mode } — 'auto' | 'assisted'. */
chaseRoutes.put('/settings', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const mode = typeof body.chase_mode === 'string' ? body.chase_mode : '';
  if (!CHASE_MODES.has(mode)) return c.json({ error: 'chase_mode_invalid' }, 400);

  await c.env.DB.prepare('UPDATE events SET chase_mode = ?, updated_at = ? WHERE id = ?')
    .bind(mode, new Date().toISOString(), session.eventId)
    .run();
  return c.json({ ok: true, chase_mode: mode });
});

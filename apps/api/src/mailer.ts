// The one sending path (docs/08 §3): render → message_log (idempotent) →
// outbox → immediate attempt. Every outbound email flows through here so
// "did they get it?" is always answerable from message_log, and no trigger
// can double-send — the INSERT OR IGNORE on the idempotency key is the gate.

import type { Context } from 'hono';
import { createDb } from '@kms/db';
import {
  renderTemplate,
  selectCalendarProvider,
  selectProvider,
  type IcsPayload,
  type OutgoingEmail,
  type TemplateOverride,
  type ThemeConfig,
} from '@kms/email';
import type { AppEnv, Env } from './env';

export interface SendTemplatedArgs {
  templateKey: string;
  eventId: string;
  contactId: string | null;
  toEmail: string;
  /** entity the message is about (submission id, assignment id, token hash…) */
  entityId: string;
  /** bump to deliberately re-send about the same entity (e.g. ICS SEQUENCE) */
  version?: number | string;
  context: Record<string, unknown>;
  ics?: IcsPayload;
}

export interface OutboxEmailPayload extends OutgoingEmail {
  /** message_log idempotency key, for status updates from the sweep */
  log_key: string;
  /** route through the calendar-capable provider (docs/08 §5) */
  calendar?: boolean;
}

export type SendOutcome = 'queued' | 'duplicate' | 'template_disabled';

async function loadOverride(
  db: D1Database,
  eventId: string,
  key: string,
): Promise<{ override: TemplateOverride | null; themeId: string | null }> {
  const row = await db
    .prepare('SELECT subject, body_richtext, enabled, theme_id FROM email_templates WHERE event_id = ? AND key = ?')
    .bind(eventId, key)
    .first<TemplateOverride & { theme_id: string | null }>();
  return row
    ? { override: { subject: row.subject, body_richtext: row.body_richtext, enabled: row.enabled }, themeId: row.theme_id }
    : { override: null, themeId: null };
}

async function loadTheme(db: D1Database, eventId: string, themeId: string | null): Promise<ThemeConfig | null> {
  if (themeId) {
    const row = await db.prepare('SELECT * FROM email_themes WHERE id = ?').bind(themeId).first<ThemeConfig>();
    if (row) return row;
  }
  // Event default: the first theme, if the event has any.
  return db
    .prepare('SELECT * FROM email_themes WHERE event_id = ? ORDER BY rowid LIMIT 1')
    .bind(eventId)
    .first<ThemeConfig>();
}

/**
 * Render one templated email into message_log + outbox without attempting
 * delivery — the caller (or the next sweep tick) delivers. Returns
 * 'duplicate' when this exact (template, contact, entity, version) was
 * already sent or queued; callers may treat that as success. Usable from
 * cron sweeps, which have no request context.
 */
export async function queueTemplated(
  db: D1Database,
  args: SendTemplatedArgs,
): Promise<{ outcome: SendOutcome; payload?: OutboxEmailPayload }> {
  const { override, themeId } = await loadOverride(db, args.eventId, args.templateKey);
  const theme = await loadTheme(db, args.eventId, themeId);
  const rendered = renderTemplate(args.templateKey, override, theme, args.context);
  if (!rendered) return { outcome: 'template_disabled' };

  const logKey = `${args.templateKey}:${args.contactId ?? 'none'}:${args.entityId}:v${args.version ?? 1}`;
  const ts = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO message_log
         (id, event_id, template_key, to_email, contact_id, subject, status, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(crypto.randomUUID(), args.eventId, args.templateKey, args.toEmail, args.contactId, rendered.subject, logKey, ts)
    .run();
  if (inserted.meta.changes === 0) return { outcome: 'duplicate' };

  const payload: OutboxEmailPayload = {
    to: args.toEmail,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    ...(args.ics ? { ics: args.ics, calendar: true } : {}),
    log_key: logKey,
  };
  await createDb(db).outbox.enqueue({ kind: 'email', idempotencyKey: logKey, payload });
  return { outcome: 'queued', payload };
}

/**
 * Request-path variant: queue, then attempt delivery via waitUntil so the
 * response never waits on the provider. On success the outbox row is
 * settled so the sweep cannot resend; on failure the sweep is the retry.
 */
export async function sendTemplated<E extends AppEnv>(c: Context<E>, args: SendTemplatedArgs): Promise<SendOutcome> {
  const db = c.env.DB;
  const { outcome, payload } = await queueTemplated(db, args);
  if (outcome !== 'queued' || !payload) return outcome;

  const attempt = deliverEmail(db, c.env, payload)
    .then(() => createDb(db).outbox.markDoneByKey(payload.log_key))
    .catch((err: unknown) => {
      console.error(`immediate send failed (${args.templateKey}):`, err instanceof Error ? err.message : 'unknown');
    });
  try {
    c.executionCtx.waitUntil(attempt);
  } catch {
    await attempt; // environments without an execution context (tests)
  }
  return outcome;
}

/** Send one payload and reflect the result in message_log. Throws on failure. */
export async function deliverEmail(db: D1Database, env: Env, payload: OutboxEmailPayload): Promise<void> {
  const provider = payload.calendar ? selectCalendarProvider(env) : selectProvider(env);
  try {
    const result = await provider.send(payload);
    await db
      .prepare(
        `UPDATE message_log SET status = 'sent', provider_message_id = ?, sent_at = ?, error = NULL
         WHERE idempotency_key = ? AND status != 'sent'`,
      )
      .bind(result.providerMessageId, new Date().toISOString(), payload.log_key)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .prepare(`UPDATE message_log SET error = ? WHERE idempotency_key = ? AND status != 'sent'`)
      .bind(message, payload.log_key)
      .run();
    throw err;
  }
}

/** Terminal failure (outbox row dead): message_log shows failed. */
export async function markEmailFailed(db: D1Database, logKey: string, error: string): Promise<void> {
  await db
    .prepare(`UPDATE message_log SET status = 'failed', error = ? WHERE idempotency_key = ? AND status != 'sent'`)
    .bind(error, logKey)
    .run();
}

// Magic-link auth (docs/03 §5, NFR-4): 32-byte single-use token, only its SHA-256 hash
// is stored (KV, 15-min TTL). Tokens are never logged. Session = signed HttpOnly cookie.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '@kms/db';
import {
  createConsoleProvider,
  createResendProvider,
  type EmailProvider,
  type OutgoingEmail,
} from '@kms/email';
import type { AppEnv, Env } from '../env';
import { esc, page } from '../html';
import { clearSessionCookie, createSessionToken, setSessionCookie } from '../session';

export const authRoutes = new Hono<AppEnv>();

const MAGIC_TTL_SECONDS = 900; // 15 minutes, single-use

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same provider selection as the jobs worker: Resend outside DEV_MODE, else console. */
function selectProvider(env: Env): EmailProvider {
  if (env.RESEND_API_KEY && env.DEV_MODE !== 'on') {
    return createResendProvider(env.RESEND_API_KEY, env.EMAIL_FROM ?? 'KMS <no-reply@example.com>');
  }
  return createConsoleProvider();
}

function wantsJson(accept: string | undefined): boolean {
  return (accept ?? '').includes('application/json');
}

/** Only same-origin relative paths may be used as post-login destinations. */
function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.startsWith('/') && !value.startsWith('//') ? value : null;
}

async function readBody(c: Context<AppEnv>) {
  const contentType = c.req.header('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody();
  return {
    email: typeof body.email === 'string' ? body.email : '',
    event_slug: typeof body.event_slug === 'string' ? body.event_slug : '',
    redirect_to: safeRedirect(body.redirect_to),
  };
}

// POST /auth/request — accept form or JSON {email, event_slug}, mint + email a magic link.
authRoutes.post('/request', async (c) => {
  const { email, event_slug, redirect_to } = await readBody(c);
  const json = wantsJson(c.req.header('accept'));

  if (!email || !event_slug) {
    if (json) return c.json({ ok: false, error: 'email and event_slug are required' }, 400);
    return c.html(page('Sign in', '<h1>Missing details</h1><p>Both an email address and an event are required.</p>'), 400);
  }

  const db = createDb(c.env.DB);
  const event = await db.events.getBySlug(event_slug);
  if (!event) {
    if (json) return c.json({ ok: false, error: 'event_not_found' }, 404);
    return c.html(page('Event not found', '<h1>Event not found</h1><p>We could not find that event.</p>'), 404);
  }

  const contact = await db.contacts.upsertByEmail(event.id, email.trim().toLowerCase());

  // 32-byte random token; only its SHA-256 hash is stored (single-use, 15-min TTL).
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = b64url(raw);
  const hash = await sha256hex(token);
  await c.env.KV.put(
    `magic:${hash}`,
    JSON.stringify({
      contactId: contact.id,
      eventId: event.id,
      ...(redirect_to ? { redirectTo: redirect_to } : {}),
    }),
    { expirationTtl: MAGIC_TTL_SECONDS },
  );

  const link = `${c.env.APP_URL}/auth/callback?t=${token}`;
  const mail: OutgoingEmail = {
    to: contact.email,
    subject: 'Your sign-in link',
    text: `Sign in to ${event.name}:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once. If you did not request it, you can ignore this email.`,
    html: `<p>Sign in to <strong>${esc(event.name)}</strong>:</p><p><a href="${esc(link)}">Sign in to ${esc(event.name)}</a></p><p>This link expires in 15 minutes and can only be used once. If you did not request it, you can ignore this email.</p>`,
  };

  // Outbox first (cron sweep retries it), then attempt an immediate send (docs/03 §2a).
  await db.outbox.enqueue({ kind: 'email', idempotencyKey: `magic-${hash}`, payload: mail });
  const immediate = selectProvider(c.env)
    .send(mail)
    .catch((err: unknown) => {
      // Never log the token/link — the message text stays out of logs.
      console.error('magic-link immediate send failed:', err instanceof Error ? err.message : 'unknown error');
    });
  try {
    c.executionCtx.waitUntil(immediate);
  } catch {
    await immediate; // test environments without an execution context
  }

  const dev = c.env.DEV_MODE === 'on';
  if (json) {
    return c.json(dev ? { ok: true, dev_link: link } : { ok: true });
  }
  const devBlock = dev
    ? `<div class="devlink"><strong>DEV_MODE</strong> — your sign-in link:<br><a href="${esc(link)}">${esc(link)}</a></div>`
    : '';
  return c.html(
    page(
      'Check your email',
      `<h1>Check your email</h1>
<p>If <strong>${esc(contact.email)}</strong> is valid, a sign-in link for <strong>${esc(event.name)}</strong> is on its way.</p>
<p class="muted">The link expires in 15 minutes and can only be used once.</p>${devBlock}`,
    ),
  );
});

// GET /auth/callback?t=… — verify + consume the token, set the session cookie, redirect.
authRoutes.get('/callback', async (c) => {
  const token = c.req.query('t');
  const expired = () =>
    c.html(
      page(
        'Link expired',
        `<h1>This link has expired</h1>
<p>Sign-in links are valid for 15 minutes and can only be used once.</p>
<p>Please request a new one from the portal login page.</p>`,
      ),
      410,
    );

  if (!token) return expired();

  const hash = await sha256hex(token);
  const key = `magic:${hash}`;
  const stored = await c.env.KV.get(key);
  if (!stored) return expired();
  await c.env.KV.delete(key); // single-use (NFR-4)

  let ref: { contactId: string; eventId: string; redirectTo?: string };
  try {
    ref = JSON.parse(stored) as { contactId: string; eventId: string; redirectTo?: string };
  } catch {
    return expired();
  }

  const db = createDb(c.env.DB);
  const [contact, event] = await Promise.all([
    db.contacts.getById(ref.eventId, ref.contactId),
    db.events.getById(ref.eventId),
  ]);
  if (!contact || !event) return expired();

  const role = await db.eventUsers.getRole(event.id, contact.id);
  const sessionToken = await createSessionToken(
    {
      contactId: contact.id,
      eventId: event.id,
      eventSlug: event.slug,
      email: contact.email,
      role,
    },
    c.env.SESSION_SECRET,
  );
  setSessionCookie(c, sessionToken);

  const dest =
    safeRedirect(ref.redirectTo) ??
    (role === 'admin' || role === 'owner' ? '/app' : `/portal/${event.slug}`);
  return c.redirect(dest);
});

// GET /auth/logout — clear the cookie, back to the root.
authRoutes.get('/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/');
});

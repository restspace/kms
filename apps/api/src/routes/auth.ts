// Magic-link auth (docs/03 §5, NFR-4): 32-byte single-use token, only its
// SHA-256 hash is stored — in D1 `auth_tokens` (sweep item P0-2), so consuming
// a link is one atomic conditional UPDATE and two concurrent callbacks cannot
// both mint a session. Tokens are never logged. Session = signed HttpOnly cookie.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '@kms/db';
import type { AppEnv } from '../env';
import { esc, page } from '../html';
import { sendTemplated } from '../mailer';
import { clearSessionCookie, createSessionToken, setSessionCookie } from '../session';
import { cleanupExpiredTokensStatement, consumeToken, mintToken, sha256hex } from '../tokens';
import type { TokenPurpose } from '../tokens';

export const authRoutes = new Hono<AppEnv>();

/** Purposes a sign-in callback will honour: the portal login link, the
 *  submission-confirmation link (P0-3) and the admin login link. */
const CALLBACK_PURPOSES: readonly TokenPurpose[] = ['portal-login', 'submission-confirm', 'admin-login'];

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

/**
 * Cron sweep helper: drop long-expired token rows. `/auth` owns the token
 * lifecycle, but the scheduled handler lives in index.ts (another lane) —
 * it only has to call this.
 */
export async function cleanupExpiredAuthTokens(db: D1Database): Promise<number> {
  const result = await cleanupExpiredTokensStatement(db).run();
  return result.meta.changes ?? 0;
}

// POST /auth/request — accept form or JSON {email, event_slug}, mint + email a magic link.
authRoutes.post('/request', async (c) => {
  const { email, event_slug, redirect_to } = await readBody(c);
  const json = wantsJson(c.req.header('accept'));
  const normalisedEmail = email.trim().toLowerCase();

  if (!event_slug || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
    if (json) return c.json({ ok: false, error: 'a valid email and event_slug are required' }, 400);
    return c.html(page('Sign in', '<h1>Check your details</h1><p>A valid email address and an event are required.</p>'), 400);
  }

  const db = createDb(c.env.DB);
  const event = await db.events.getBySlug(event_slug);
  if (!event) {
    if (json) return c.json({ ok: false, error: 'event_not_found' }, 404);
    return c.html(page('Event not found', '<h1>Event not found</h1><p>We could not find that event.</p>'), 404);
  }

  const contact = await db.contacts.upsertByEmail(event.id, normalisedEmail);

  // One request path serves both destinations (the role decides where the
  // callback lands), so the link is minted as 'portal-login'; the callback
  // accepts every sign-in purpose. Only the hash reaches D1.
  const { raw: token, statement } = await mintToken(c.env.DB, {
    contactId: contact.id,
    eventId: event.id,
    purpose: 'portal-login',
    redirectTo: redirect_to,
  });
  await statement.run();
  const hash = await sha256hex(token);

  const link = `${c.env.APP_URL}/auth/callback?t=${token}`;
  // Through the template pipeline (docs/08): message_log row, outbox retry,
  // immediate attempt. The token hash keys idempotency — one send per link.
  // The rendered body carries the link; mailer never logs message content.
  await sendTemplated(c, {
    templateKey: 'magic_link',
    eventId: event.id,
    contactId: contact.id,
    toEmail: contact.email,
    entityId: hash,
    context: { event: { name: event.name }, magic_link: link },
  });

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

  // Single atomic UPDATE: exactly one concurrent caller can win, and replays,
  // expired rows and wrong-purpose tokens all come back null.
  const consumed = await consumeToken(c.env.DB, token, CALLBACK_PURPOSES);
  if (!consumed) return expired();

  const db = createDb(c.env.DB);
  const [contact, event] = await Promise.all([
    db.contacts.getById(consumed.event_id, consumed.contact_id),
    db.events.getById(consumed.event_id),
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

  // Admins and reviewers land in the app (reviewers get the review
  // workspace); speakers land in their portal. A confirmation link always
  // means "your submission" — default it to the event's portal.
  const fallback =
    consumed.purpose === 'submission-confirm' || role === 'speaker' ? `/portal/${event.slug}` : '/app';
  const dest = safeRedirect(consumed.redirect_to) ?? fallback;
  return c.redirect(dest);
});

// GET /auth/logout — clear the cookie, back to the root.
authRoutes.get('/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/');
});

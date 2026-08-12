// Magic-link auth (docs/03 §5, NFR-4): 32-byte single-use token, only its
// SHA-256 hash is stored — in D1 `auth_tokens` (sweep item P0-2), so consuming
// a link is one atomic conditional UPDATE and two concurrent callbacks cannot
// both mint a session. Tokens are never logged. Session = signed HttpOnly cookie.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '@kms/db';
import type { AttachSource } from '@kms/db';
import type { AppEnv } from '../env';
import { esc, page } from '../html';
import { demoLogins } from './landing';
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

/**
 * Core of the magic-link request, factored out so the public CFP wizard's
 * Account step (submit.tsx — an *existing* email must never be silently
 * signed in) can reuse exactly the same demo-carve-out and send logic as the
 * portal's own `/auth/request` form, instead of re-deriving it.
 */
export async function requestMagicLink(
  c: Context<AppEnv>,
  args: {
    email: string;
    event: { id: string; name: string };
    redirectTo?: string | null;
    /**
     * How to stamp event_contacts.source when this call is what first attaches
     * the contact to the event. Defaults to 'cfp' because the public login form
     * and the CFP wizard are the two paths that create people; the reviewer
     * invite passes 'admin' so the roster records who really added them.
     */
    attachSource?: AttachSource;
  },
): Promise<{ devLink: string | null }> {
  const db = createDb(c.env.DB);
  // Contacts are org-scoped as of 0015, and callers only hand us the event, so
  // the org is read off the event row.
  const event = await db.events.getById(args.event.id);
  if (!event) throw new Error(`requestMagicLink: unknown event ${args.event.id}`);

  // Look up, never create (workplan §5). This endpoint is unauthenticated —
  // anyone can type any address against any event slug — so creating here let
  // a stranger litter the organisation with empty contact rows. Creation now
  // belongs to the paths that have a reason to add a person: the CFP wizard,
  // the importer, and staff adding someone by hand. Every caller of this
  // function already resolved or created its contact first; only the public
  // /auth/request form can arrive with an address we do not know.
  //
  // Nor is the contact attached to the event here: attaching would let a
  // stranger add an existing org contact to this event's roster and, because
  // attachToEvent seeds from their most recent event, copy another event
  // team's biography/company/job_title across with them. That happens in
  // /auth/callback, once consuming the token has proven the caller receives
  // mail at this address.
  const contact = await db.contacts.getByEmail(event.org_id, args.email);
  // Silently do nothing for an unknown address. The caller's response must not
  // depend on this, or the form becomes an address-enumeration oracle.
  if (!contact) return { devLink: null };

  // One request path serves both destinations (the role decides where the
  // callback lands), so the link is minted as 'portal-login'; the callback
  // accepts every sign-in purpose. Only the hash reaches D1.
  const { raw: token, statement } = await mintToken(c.env.DB, {
    contactId: contact.id,
    eventId: args.event.id,
    purpose: 'portal-login',
    redirectTo: args.redirectTo,
  });
  await statement.run();
  const hash = await sha256hex(token);

  const dev = c.env.DEV_MODE === 'on';
  // Local dev can run two wrangler instances off the same .dev.vars (`dev` on
  // 8787, `dev:kms2` on 8788), so a single APP_URL can only ever match one of
  // them. In DEV_MODE the link follows the origin the request arrived on, so
  // each instance links back to itself.
  const origin = dev ? new URL(c.req.url).origin : c.env.APP_URL;
  const link = `${origin}/auth/callback?t=${token}`;
  // Demo carve-out (docs/12 §2): the landing page's one-click logins use seeded
  // contacts whose @example.com addresses can't receive mail, so on the public
  // demo instance (DEMO_RESET=on) the link is shown inline and the email is
  // skipped — a send to those addresses could only bounce. Only the two seeded
  // demo addresses qualify; everyone else gets the mail path, and DEV_MODE
  // stays off in production.
  let demoInline = false;
  if (!dev && c.env.DEMO_RESET === 'on') {
    const demo = await demoLogins(c.env.DB);
    demoInline =
      args.email === demo?.adminEmail?.toLowerCase() || args.email === demo?.speakerEmail?.toLowerCase();
  }
  const showLink = dev || demoInline;

  if (!demoInline) {
    // Through the template pipeline (docs/08): message_log row, outbox retry,
    // immediate attempt. The token hash keys idempotency — one send per link.
    // The rendered body carries the link; mailer never logs message content.
    await sendTemplated(c, {
      templateKey: 'magic_link',
      eventId: args.event.id,
      contactId: contact.id,
      toEmail: contact.email,
      entityId: hash,
      context: { event: { name: args.event.name }, magic_link: link },
    });
  }
  return { devLink: showLink ? link : null };
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

  const { devLink: link } = await requestMagicLink(c, { email: normalisedEmail, event, redirectTo: redirect_to });

  if (json) {
    return c.json(link !== null ? { ok: true, dev_link: link } : { ok: true });
  }
  const devBlock =
    link !== null
      ? `<div class="devlink"><strong>${c.env.DEV_MODE === 'on' ? 'DEV_MODE' : 'Demo login'}</strong> — your sign-in link:<br><a href="${esc(link)}">${esc(link)}</a></div>`
      : '';
  return c.html(
    page(
      'Check your email',
      `<h1>Check your email</h1>
<p>If <strong>${esc(normalisedEmail)}</strong> is valid, a sign-in link for <strong>${esc(event.name)}</strong> is on its way.</p>
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
  const event = await db.events.getById(consumed.event_id);
  if (!event) return expired();

  // Consuming the token proves the caller received mail at this contact's
  // address, which is what earns them a place on the event's roster. Attaching
  // here rather than at request time is what keeps requestMagicLink safe for
  // unauthenticated callers; see the note there. Idempotent, so a returning
  // speaker who is already on the roster keeps the profile they have.
  // 'cfp' is the closest of the four sources for a self-service arrival: the
  // person put their own address in, rather than staff or an import adding them.
  await db.contacts.attachToEvent(event.id, consumed.contact_id, 'cfp');

  const contact = await db.contacts.getById(consumed.event_id, consumed.contact_id);
  if (!contact) return expired();

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

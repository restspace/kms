// /app — the admin SPA. The session/role gate lives here in the Worker
// (run_worker_first in wrangler.toml routes /app past the asset handler):
// no session → SSR login page; non-admin → 403; otherwise the built SPA shell
// from the ASSETS binding. Data access is gated separately in /app/api.

import { Hono } from 'hono';
import { createDb } from '@kms/db';
import { can } from '@kms/core';
import type { Actor, Event } from '@kms/core';
import type { AppEnv } from '../env';
import { esc, page } from '../html';
import { getRevalidatedPrivilegedSession } from '../session';

export const adminRoutes = new Hono<AppEnv>();

/**
 * The unauthenticated /app gate. `error` re-renders it after a failed
 * POST /auth/login that carried surface=admin (auth.ts), so the password form
 * reports "invalid email or password" in place rather than on the portal page.
 */
export function adminLoginPage(events: Event[], error?: string): string {
  const options = events
    .map((e) => `<option value="${esc(e.slug)}">${esc(e.name)}</option>`)
    .join('');
  const eventField = (id: string) =>
    events.length === 0
      ? '<p class="muted">No events exist yet — seed the database first.</p>'
      : `<label for="${id}">Event</label>
<select id="${id}" name="event_slug" required>${options}</select>`;
  const errorHtml = error ? `<p class="field-err">${esc(error)}</p>` : '';
  return page(
    'Admin sign in',
    `<h1>Admin sign in</h1>
<p>Enter your email address and we will send you a sign-in link.</p>
<form method="post" action="/auth/request">
  <label for="email">Email address</label>
  <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
  ${eventField('event_slug')}
  <button type="submit">Email me a sign-in link</button>
</form>
<h2>Or sign in with a password</h2>
${errorHtml}
<form method="post" action="/auth/login">
  <label for="pw-email">Email address</label>
  <input type="email" id="pw-email" name="email" required autocomplete="email" placeholder="you@example.com">
  <label for="pw-password">Password</label>
  <input type="password" id="pw-password" name="password" required autocomplete="current-password">
  ${eventField('pw-event-slug')}
  <input type="hidden" name="surface" value="admin">
  <button type="submit">Sign in</button>
</form>`,
  );
}

const forbidden = page(
  'Forbidden',
  `<h1>403 — Admin access required</h1>
<p>Your account does not have admin access to this event.</p>
<p><a href="/auth/logout">Log out</a> and sign in with an admin account.</p>`,
);

// GET /app — gate, then hand over the built SPA shell.
adminRoutes.get('/', async (c) => {
  const session = await getRevalidatedPrivilegedSession(c);
  if (!session) {
    const events = await createDb(c.env.DB).events.listAll();
    return c.html(adminLoginPage(events), 401);
  }
  const actor: Actor = {
    contactId: session.contactId,
    email: session.email,
    role: session.role,
    ...(session.impersonatedBy ? { impersonatedBy: session.impersonatedBy } : {}),
  };
  // Reviewers load the same shell; the SPA renders only the reviewer
  // workspace for them (role comes from /app/api/me).
  if (!can(actor, 'review.view')) {
    return c.html(forbidden, 403);
  }

  const shell = await c.env.ASSETS.fetch(new URL('/app/index.html', c.req.url));
  if (!shell.ok) {
    return c.html(
      page('Build missing', '<h1>Admin build missing</h1><p>Run <span class="code">npm run build:admin</span> and reload.</p>'),
      503,
    );
  }
  // The admin SPA must never be framed (lane W3-A made framing an explicit,
  // per-surface decision: the public /e/:slug pages opt *in*, this opts out).
  // X-Frame-Options for older agents, CSP frame-ancestors for current ones.
  return c.html(await shell.text(), 200, {
    // Vite's hashed lazy chunks can disappear on the next deployment. Always
    // revalidate the entry HTML so a recovery reload cannot receive an old
    // bundle that still references the removed filenames.
    'cache-control': 'no-cache',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
});

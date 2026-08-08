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
import { getSession } from '../session';

export const adminRoutes = new Hono<AppEnv>();

function adminLoginPage(events: Event[]): string {
  const options = events
    .map((e) => `<option value="${esc(e.slug)}">${esc(e.name)}</option>`)
    .join('');
  const eventField =
    events.length === 0
      ? '<p class="muted">No events exist yet — seed the database first.</p>'
      : `<label for="event_slug">Event</label>
<select id="event_slug" name="event_slug" required>${options}</select>`;
  return page(
    'Admin sign in',
    `<h1>Admin sign in</h1>
<p>Enter your email address and we will send you a sign-in link.</p>
<form method="post" action="/auth/request">
  <label for="email">Email address</label>
  <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
  ${eventField}
  <button type="submit">Email me a sign-in link</button>
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
  const session = await getSession(c);
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
  return c.html(await shell.text());
});

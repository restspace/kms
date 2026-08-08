// Admin shell (M0 exit screen): guarded by can(actor, 'admin.view'); lists events with
// submission counts and a "View Portal" link per event.

import { Hono } from 'hono';
import { createDb } from '@kms/db';
import { can } from '@kms/core';
import type { Actor, Event } from '@kms/core';
import type { AppEnv } from '../env';
import { esc, page } from '../html';
import { getSession } from '../session';

export const adminRoutes = new Hono<AppEnv>();

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtDates(event: Event): string {
  const start = fmtDate(event.starts_at);
  const end = fmtDate(event.ends_at);
  return start === end ? start : `${start} – ${end}`;
}

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

// Guard every /app route: no session → login page; non-admin → 403.
adminRoutes.use('*', async (c, next) => {
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
  if (!can(actor, 'admin.view')) {
    return c.html(forbidden, 403);
  }
  await next();
});

// GET /app — admin shell: events with submission counts, linking to each portal.
adminRoutes.get('/', async (c) => {
  const session = await getSession(c);
  const db = createDb(c.env.DB);
  const events = await db.events.listAll();
  const counts = await Promise.all(events.map((e) => db.submissions.countByEvent(e.id)));

  const rows =
    events.length === 0
      ? '<tr><td colspan="4" class="muted">No events yet.</td></tr>'
      : events
          .map(
            (e, i) => `<tr>
  <td><strong>${esc(e.name)}</strong><br><span class="code">${esc(e.slug)}</span></td>
  <td>${esc(fmtDates(e))}</td>
  <td>${counts[i]}</td>
  <td><a href="/portal/${esc(e.slug)}">View Portal</a></td>
</tr>`,
          )
          .join('');

  return c.html(
    page(
      'KMS — Admin',
      `<h1>Events</h1>
<p class="muted">Signed in as <strong>${esc(session?.email ?? '')}</strong> · <a href="/auth/logout">Log out</a></p>
<table>
  <thead><tr><th>Event</th><th>Dates</th><th>Submissions</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>`,
    ),
  );
});

// Speaker portal (M0): login page when no valid session for the event, otherwise a
// portal home with the visitor's submissions. Sessions are event-scoped (NFR-4).

import { Hono } from 'hono';
import { createDb } from '@kms/db';
import type { Event } from '@kms/core';
import type { AppEnv } from '../env';
import { esc, page, statusChip } from '../html';
import { clearSessionCookie, getSession } from '../session';

export const portalRoutes = new Hono<AppEnv>();

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

function loginPage(event: Event): string {
  return page(
    `Sign in — ${event.name}`,
    `<h1>${esc(event.name)}</h1>
<p class="muted">${esc(fmtDates(event))}</p>
<p>Enter your email address and we will send you a sign-in link.</p>
<form method="post" action="/auth/request">
  <label for="email">Email address</label>
  <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
  <input type="hidden" name="event_slug" value="${esc(event.slug)}">
  <button type="submit">Email me a sign-in link</button>
</form>`,
  );
}

const notFound = page(
  'Event not found',
  '<h1>Event not found</h1><p>We could not find that event. Check the link and try again.</p>',
);

// GET /portal/:slug — login page or portal home.
portalRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const db = createDb(c.env.DB);
  const event = await db.events.getBySlug(slug);
  if (!event) return c.html(notFound, 404);

  const session = await getSession(c);
  if (!session || session.eventId !== event.id) {
    return c.html(loginPage(event));
  }

  const submissions = await db.submissions.listByContact(event.id, session.contactId);
  const list =
    submissions.length === 0
      ? '<p class="muted">No submissions yet.</p>'
      : `<ul class="list">${submissions
          .map(
            (s) =>
              `<li><span class="code">${esc(s.code)}</span> <span>${esc(s.title)}</span> ${statusChip(s.status)}</li>`,
          )
          .join('')}</ul>`;

  const banner = session.impersonatedBy
    ? '<div class="banner">Admin impersonation — you are viewing this portal as this speaker.</div>'
    : '';

  return c.html(
    page(
      `${event.name} — Speaker Portal`,
      `${banner}<h1>${esc(event.name)}</h1>
<p class="muted">${esc(fmtDates(event))}</p>
<p>Signed in as <strong>${esc(session.email)}</strong> · <a href="/portal/${esc(event.slug)}/logout">Log out</a></p>
<h2>My Submissions</h2>
${list}`,
    ),
  );
});

// GET /portal/:slug/logout — same behaviour as /auth/logout.
portalRoutes.get('/:slug/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/');
});

// Speaker portal (docs/05): Home · Submissions · Profile · Tasks as an SSR
// multi-page app. Deliberately island-free — every interaction is a form
// POST with a redirect, plus a few lines of inline JS for confirms and the
// bio counter, so the portal stays fast and robust at 375 px (NFR budgets).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '@kms/db';
import {
  discardHiddenAnswers,
  isValidEmailShape,
  isValidUrlShape,
  MAX_PARTICIPANTS_PER_SUBMISSION,
  normalizeXHandleToUrl,
  parseParticipantRoles,
  redactInternal,
  sanitizeRichHtml,
  validateAnswers,
  visibleQuestionIds,
  type AnswerValue,
  type Answers,
  type Event,
  type ParticipantRoleConfig,
  type QuestionDef,
} from '@kms/core';
import type { AppEnv } from '../env';
import { esc } from '../html';
import { baseCss, statusChipCss, tokensCss } from '@kms/theme';
import {
  DOCUMENT_TYPES,
  IMAGE_TYPES,
  MAX_HEADSHOT_BYTES,
  MAX_UPLOAD_BYTES,
  saveFile,
} from '../filestore';
import { attemptImmediate, prepareTemplated, sendTemplated, type PreparedEmail } from '../mailer';
import { bumpEventRevision, entityRevisionInsert, watchedFieldsChanged } from '../revision';
import { buildPortalParticipantStatements, snapshotParticipantsRevision } from '../participants';
import { loadQuestions } from './formsAdmin';
import { isFormClosed, normaliseTrackAnswers, storableAnswers, synthesizeAnswersFromColumns } from './submit';
import { clearSessionCookie, getSession, type SessionPayload } from '../session';
import { getPortalEvents, type PortalEvent } from '../access';
import {
  addComment,
  appendUploadVersion,
  formatBytes,
  loadChainVersions,
  loadThread,
  MAX_COMMENT_CHARS,
  type FileCommentRow,
  type FileVersionRow,
} from '../fileVersions';

export const portalRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PORTAL_CSS = `
${tokensCss}
${baseCss}
${statusChipCss}
body{font-size:15px}
.wrap{max-width:880px;margin:0 auto;padding:1.25rem 1rem 4rem}
header.p-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.75rem}
header.p-head h1{font-family:var(--font-display);font-size:1.5rem;font-weight:600;margin:0}
.p-user{display:flex;align-items:center;gap:.6rem;font-size:.85rem;color:var(--text-muted)}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--accent);color:var(--accent-contrast);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;overflow:hidden;flex:0 0 auto}
.avatar img{width:100%;height:100%;object-fit:cover}
nav.pills{display:flex;justify-content:center;gap:.35rem;flex-wrap:wrap;margin:0 0 1.4rem}
nav.pills a{padding:.45rem 1.1rem;border-radius:999px;text-decoration:none;font-family:var(--font-display);color:var(--text-secondary);font-weight:600;font-size:.9rem}
nav.pills a.active{background:var(--accent);color:var(--accent-contrast)}
nav.pills a:not(.active):hover{background:var(--chrome);color:var(--text)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.25rem;margin-bottom:1rem}
.card h2{font-family:var(--font-display);font-size:1rem;margin:0 0 .75rem;display:flex;align-items:baseline;gap:.5rem}
.card h2 .count{color:var(--text-muted);font-weight:400;font-size:.85rem}
.card h2 a{margin-left:auto;font-size:.82rem}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
.sub-card{display:block;border:1px solid var(--border);border-radius:var(--radius);padding:.7rem .9rem;margin-bottom:.6rem;text-decoration:none;color:inherit}
.sub-card:hover{border-color:var(--accent-border)}
.sub-card .t1{font-weight:600}
.sub-card .t2{color:var(--text-muted);font-size:.85rem}
.task{border:1px solid var(--border);border-radius:var(--radius);padding:.8rem .9rem;margin-bottom:.6rem}
.task .t-head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.task .t-title{font-weight:600;flex:1 1 auto}
.task .due{font-size:.82rem;color:var(--text-muted)}
.task .due.overdue{color:var(--danger-strong);font-weight:700}
.badge-overdue{background:var(--status-declined-bg);color:var(--status-declined-text);border-radius:var(--radius);padding:.05rem .4rem;font-size:.72rem;font-weight:700}
.t-status{font-size:.75rem;font-weight:600;border-radius:999px;padding:.1rem .6rem}
.t-status.not_started{background:var(--status-draft-bg);color:var(--status-draft-text)}
.t-status.in_progress{background:var(--status-pending-bg);color:var(--status-pending-text)}
.t-status.complete{background:var(--status-accepted-bg);color:var(--status-accepted-text)}
.t-body{margin-top:.6rem;border-top:1px solid var(--border);padding-top:.6rem}
button,.btn{display:inline-block;border:0;border-radius:var(--radius);background:var(--accent);color:var(--accent-contrast);font:inherit;font-weight:600;padding:.5rem 1.1rem;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--accent-strong);color:var(--accent-contrast)}
button.secondary,.btn.secondary{background:var(--surface);color:var(--text);border:1px solid var(--border-strong)}
button.secondary:hover,.btn.secondary:hover{background:var(--surface-hover);color:var(--text)}
button.danger{background:var(--surface);color:var(--danger-strong);border:1px solid var(--danger-border)}
button.danger:hover{background:var(--danger-soft);color:var(--danger-strong)}
.flash{border-radius:var(--radius);padding:.6rem .9rem;margin-bottom:1rem;font-size:.9rem}
.flash.ok{background:var(--status-accepted-bg);color:var(--status-accepted-text);border:1px solid var(--status-accepted-text)}
.flash.err{background:var(--danger-soft);color:var(--danger-strong);border:1px solid var(--danger-border)}
dl.detail{display:grid;grid-template-columns:150px 1fr;gap:.4rem .8rem;font-size:.92rem;margin:0}
dl.detail dt{color:var(--text-muted)}
dl.detail dd{margin:0;overflow-wrap:anywhere}
.counter{font-weight:400;color:var(--text-muted);font-size:.78rem;margin-left:.4rem}
.headshot-preview{width:96px;height:96px;border-radius:50%;object-fit:cover;border:1px solid var(--border);display:block;margin-bottom:.5rem}
.errsum{background:var(--danger-soft);color:var(--danger-strong);border:1px solid var(--danger-border);border-radius:var(--radius);padding:.7rem .9rem;margin-bottom:1rem}
.errsum h2{font-size:.95rem;margin:0 0 .4rem;color:var(--danger-strong)}
.errsum ul{margin:0;padding-left:1.1rem}
.errsum a{color:var(--danger-strong)}
.errsum:focus{outline:2px solid var(--danger-strong);outline-offset:2px}
.field-err{color:var(--danger-strong);font-size:.82rem;margin:.25rem 0 0}
[aria-invalid=true]{border-color:var(--danger)}
.qhelp{color:var(--text-muted);font-size:.82rem;margin:.15rem 0 0}
.vlist{list-style:none;margin:.3rem 0 .6rem;padding:0}
.vrow{display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;padding:.4rem 0;border-bottom:1px solid var(--border)}
.vrow:last-child{border-bottom:0}
.vtag{font-size:.72rem;font-weight:700;border-radius:var(--radius);padding:.05rem .4rem;background:var(--chrome);color:var(--text-secondary)}
.vtag.current{background:var(--status-accepted-bg);color:var(--status-accepted-text)}
.vmeta{color:var(--text-muted);font-size:.8rem}
.thread{margin:.5rem 0 0;border-top:1px solid var(--border);padding-top:.6rem}
.cmt{border-left:3px solid var(--border);padding:.15rem 0 .15rem .6rem;margin-bottom:.5rem}
.cmt.staff{border-left-color:var(--accent)}
.cmt .chead{font-size:.8rem;color:var(--text-muted)}
.cmt .chead strong{color:var(--text)}
.cmt .cbody{white-space:pre-wrap;overflow-wrap:anywhere}
.p-switch{font-size:.82rem;color:var(--text-muted);margin:-.25rem 0 .75rem}
.p-switch a{margin-right:.6rem}

/* Compact (640): phone layout. Appended so the desktop rules above stand. */
@media(max-width:640px){
.wrap{padding:1rem .75rem 3rem}
nav.pills{gap:.25rem}
nav.pills a{display:flex;align-items:center;min-height:44px;padding:.5rem .8rem}
button,.btn{min-height:44px;padding:.6rem 1.1rem}
dl.detail{grid-template-columns:1fr;gap:.15rem .8rem}
dl.detail dt{margin-top:.5rem}
.task .t-head{gap:.4rem}
}
`;

type PortalSection = 'home' | 'submissions' | 'profile' | 'tasks';

interface PortalCtx {
  event: Event;
  session: SessionPayload;
  /** The contact resolved for THIS event, never `session.contactId` — see
   *  loadPortalCtx. Every ownership check on the portal keys on it. */
  contactId: string;
  contact: ContactRow;
  /** Other portals in this org this speaker may open (access.ts §5 predicate);
   *  includes the current event. Rendered as a switcher only when > 1. */
  portalEvents: PortalEvent[];
}

interface ContactRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  salutation: string | null;
  honorific: string | null;
  pronouns: string | null;
  gender: string | null;
  mobile_phone: string | null;
  biography: string | null;
  headshot_asset_id: string | null;
  links: string | null;
  company: string | null;
  job_title: string | null;
}

const displayName = (c: ContactRow): string =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email;

const initials = (c: ContactRow): string => {
  const name = displayName(c);
  return name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('') || '?';
};

function portalPage(ctx: PortalCtx, section: PortalSection, body: string, flash?: string | null): string {
  const base = `/portal/${esc(ctx.event.slug)}`;
  const nav = (
    [
      ['home', base, 'Home'],
      ['submissions', `${base}/submissions`, 'Submissions'],
      ['profile', `${base}/profile`, 'Profile'],
      ['tasks', `${base}/tasks`, 'Tasks'],
    ] as const
  )
    .map(([key, href, label]) => `<a href="${href}"${key === section ? ' class="active"' : ''}>${label}</a>`)
    .join('');
  const avatar = ctx.contact.headshot_asset_id
    ? `<span class="avatar"><img src="/files/${esc(ctx.contact.headshot_asset_id)}" alt=""></span>`
    : `<span class="avatar">${esc(initials(ctx.contact))}</span>`;
  const impersonation = ctx.session.impersonatedBy
    ? '<div class="banner">Admin impersonation — you are viewing this portal as this speaker. <a href="/app">Back to Admin</a></div>'
    : '';
  // Cross-event switcher (§5). Rendered only when this speaker really has a
  // second portal in the org — the list is relationship-gated in access.ts, so
  // its mere presence is not a disclosure, but a one-item switcher is noise.
  const others = ctx.portalEvents.filter((e) => e.event_id !== ctx.event.id);
  const switcher =
    others.length === 0
      ? ''
      : `<nav class="p-switch" aria-label="Your other events"><span>Your other events:</span> ${others
          .map((e) => `<a href="/portal/${esc(e.event_slug)}">${esc(e.event_name)}</a>`)
          .join(' ')}</nav>`;
  const flashHtml = flash
    ? flash.startsWith('!')
      ? `<div class="flash err">${esc(flash.slice(1))}</div>`
      : `<div class="flash ok">${esc(flash)}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ctx.event.name)} — Speaker Portal</title>
<style>${PORTAL_CSS}</style>
</head>
<body>
<div class="wrap">
${impersonation}
<header class="p-head">
  <h1>${esc(ctx.event.name)}</h1>
  <span class="p-user">${avatar} ${esc(displayName(ctx.contact))} · <a href="${base}/logout">Logout</a></span>
</header>
<nav class="pills">${nav}</nav>
${switcher}
${flashHtml}
${body}
</div>
</body>
</html>`;
}

// Speakers never see the internal decision queues. `accept_queue` /
// `decline_queue` mean "decided but not yet told" (docs/06 §status lifecycle) —
// the decision only becomes theirs to read when the organiser sends the batch,
// so both render exactly as `pending` does — label and chip colour alike, since
// the queue colours (green/amber) would give the decision away on their own.
const PORTAL_STATUS_ALIAS: Record<string, string> = {
  accept_queue: 'pending',
  decline_queue: 'pending',
};

function statusChipHtml(status: string): string {
  const shown = PORTAL_STATUS_ALIAS[status] ?? status;
  const label = shown.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `<span class="chip st-${esc(shown)}"><span class="dot"></span>${esc(label)}</span>`;
}

const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// F4: scheduling display for an accepted+scheduled submission, in the
// event's own timezone (the same field the public agenda groups days by —
// see landing.tsx's eventDayRange/dayKey).
const fmtDateRange = (startIso: string, endIso: string, timezone: string): string => {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${startIso} – ${endIso}`;
  let dateFmt: Intl.DateTimeFormat;
  let timeFmt: Intl.DateTimeFormat;
  try {
    dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: timezone });
    timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  } catch {
    dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const sameDay = dateFmt.format(start) === dateFmt.format(end);
  return sameDay
    ? `${dateFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}`
    : `${dateFmt.format(start)} ${timeFmt.format(start)} – ${dateFmt.format(end)} ${timeFmt.format(end)}`;
};

// ---------------------------------------------------------------------------
// Validation errors (sweep item 11). A failed POST no longer throws the user's
// typing away behind a redirect: the same page is re-rendered with every
// posted value echoed back, a focusable role="alert" summary linking to each
// bad control, and per-field aria-invalid/aria-describedby wiring. Success
// keeps Post/Redirect/Get.
// ---------------------------------------------------------------------------

export interface FieldError {
  key: string;
  message: string;
}

const fieldId = (key: string): string => `field-${key}`;
const errId = (key: string): string => `err-${key}`;

/**
 * CFP-S2 (D4): the portal home's profile nag. It used to read "Your bio or
 * headshot is missing" whichever of the two was actually absent, so a speaker
 * who had just written a bio in the submission's Participant step — which does
 * land on this very profile (participants.ts merges it into
 * event_contacts.biography) — read it as the app having lost their words, and
 * went looking for a second bio field that does not exist. It now names the
 * one thing that is missing and links straight at the control for it.
 */
function profileGapNotice(
  ctx: { contact: { biography: string | null; headshot_asset_id: string | null } },
  base: string,
): string {
  const missingBio = !ctx.contact.biography;
  const missingHeadshot = !ctx.contact.headshot_asset_id;
  if (!missingBio && !missingHeadshot) return '';
  const [what, anchor] =
    missingBio && missingHeadshot
      ? ['Your biography and headshot are missing', fieldId('biography')]
      : missingBio
        ? ['Your biography is missing', fieldId('biography')]
        : ['Your headshot is missing', fieldId('headshot')];
  return `<p class="small" style="color:var(--notice-text)">${esc(what)} — organisers use ${
    missingBio && missingHeadshot ? 'both' : 'it'
  } in the programme. <a href="${base}/profile#${esc(anchor)}">Add ${
    missingBio && missingHeadshot ? 'them' : 'it'
  } now</a>.</p>`;
}

function errorSummaryHtml(errors: FieldError[]): string {
  if (errors.length === 0) return '';
  const heading = errors.length === 1 ? 'There is a problem' : `There are ${errors.length} problems`;
  return `<div class="errsum" id="error-summary" role="alert" tabindex="-1">
<h2>${heading}</h2>
<ul>${errors.map((e) => `<li><a href="#${esc(fieldId(e.key))}">${esc(e.message)}</a></li>`).join('')}</ul>
</div>
<script>document.getElementById('error-summary').focus();</script>`;
}

/** aria wiring for a control whose value failed validation. */
function invalidAttrs(errors: FieldError[], key: string): string {
  return errors.some((e) => e.key === key)
    ? ` aria-invalid="true" aria-describedby="${esc(errId(key))}"`
    : '';
}

/** The <p> that aria-describedby points at, rendered next to its control. */
function fieldErrorHtml(errors: FieldError[], key: string): string {
  const found = errors.find((e) => e.key === key);
  return found ? `<p class="field-err" id="${esc(errId(key))}">${esc(found.message)}</p>` : '';
}

// ---------------------------------------------------------------------------
// Context middleware: event + session + contact, or the login page
// ---------------------------------------------------------------------------

/** Shell for the two unauthenticated portal cards (sign in, sign up). */
function portalAuthPage(event: Event, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(event.name)}</title><style>${PORTAL_CSS}</style></head><body><div class="wrap" style="max-width:480px">
${body}
</div></body></html>`;
}

/**
 * Portal sign-in. The magic link stays first and is still the primary path;
 * a password is the shortcut for people who set one up. `opts` re-renders the
 * page after a failed POST /auth/login (auth.ts) with the address preserved.
 */
export function loginPage(event: Event, opts?: { error?: string; email?: string }): string {
  const error = opts?.error ? `<p class="field-err">${esc(opts.error)}</p>` : '';
  const email = esc(opts?.email ?? '');
  return portalAuthPage(
    event,
    'Sign in',
    `<div class="card"><h2>${esc(event.name)}</h2>
<p>Enter your email address and we will send you a sign-in link.</p>
<form method="post" action="/auth/request">
<label for="email">Email address</label>
<input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com" value="${email}">
<input type="hidden" name="event_slug" value="${esc(event.slug)}">
<p><button type="submit">Email me a sign-in link</button></p>
</form></div>
<div class="card"><h2>Or sign in with a password</h2>
${error}
<form method="post" action="/auth/login">
<label for="pw-email">Email address</label>
<input type="email" id="pw-email" name="email" required autocomplete="email" placeholder="you@example.com" value="${email}">
<label for="pw-password">Password</label>
<input type="password" id="pw-password" name="password" required autocomplete="current-password">
<input type="hidden" name="event_slug" value="${esc(event.slug)}">
<p><button type="submit">Sign in</button></p>
</form>
<p class="muted">First time? <a href="/portal/${esc(event.slug)}/signup">Create a password</a> — we'll email you a confirmation link.</p>
</div>`,
  );
}

/** Portal sign-up: choose a password, then prove the mailbox by magic link. */
export function signupPage(event: Event, opts?: { error?: string; email?: string }): string {
  const error = opts?.error ? `<p class="field-err">${esc(opts.error)}</p>` : '';
  return portalAuthPage(
    event,
    'Create a password',
    `<div class="card"><h2>Create a password</h2>
<p>Choose a password for <strong>${esc(event.name)}</strong>. We will email you a link to confirm it before it works.</p>
${error}
<form method="post" action="/auth/signup">
<label for="su-email">Email address</label>
<input type="email" id="su-email" name="email" required autocomplete="email" placeholder="you@example.com" value="${esc(opts?.email ?? '')}">
<label for="su-password">Password</label>
<input type="password" id="su-password" name="password" required minlength="8" autocomplete="new-password">
<p class="muted">At least 8 characters.</p>
<input type="hidden" name="event_slug" value="${esc(event.slug)}">
<p><button type="submit">Create password</button></p>
</form>
<p class="muted"><a href="/portal/${esc(event.slug)}">Back to sign in</a></p>
</div>`,
  );
}

// GET /portal/:slug/signup — unauthenticated by design (it is the page you
// reach when you have no session yet), so it is registered ahead of every
// loadPortalCtx-guarded route below.
portalRoutes.get('/:slug/signup', async (c) => {
  const event = await createDb(c.env.DB).events.getBySlug(c.req.param('slug') ?? '');
  if (!event) return c.html('<h1>Event not found</h1>', 404);
  return c.html(signupPage(event));
});

async function loadPortalCtx(c: Context<AppEnv>): Promise<PortalCtx | Response> {
  const slug = c.req.param('slug') ?? '';
  const db = createDb(c.env.DB);
  const event = await db.events.getBySlug(slug);
  if (!event) return c.html('<h1>Event not found</h1>', 404);
  const session = await getSession(c);
  if (!session) return c.html(loginPage(event), 401);
  // The URL's event decides which contact this is (§5), not the cookie. The old
  // guard was `session.eventId !== event.id`, which pinned a speaker to the one
  // event their cookie was minted against; a person who speaks at two events in
  // the org had to sign in again to cross between them.
  //
  // Email is the key, not `session.contactId`. Contacts are ORG-scoped since
  // 0015, so the same person is a different contact row in a different org, and
  // the event in the URL is what determines the org. Matching on the cookie's
  // contact id would therefore resolve nothing at all across an org boundary,
  // and inside one org it would only ever agree with the email anyway.
  //
  // Identity comes from `contacts`, profile from this event's `event_contacts`
  // row. Columns are listed explicitly rather than `SELECT *` because the join
  // makes a star ambiguous, and because `notes` — the one organiser-only profile
  // column — must never be selected on a speaker-facing surface. The
  // redactInternal boundary stays in place behind that (manual-review-1 item 3).
  //
  // The event_contacts join is the membership guard AND the fetch: a contact who
  // belongs to the org but not to this event has no profile row here, so the
  // query returns nothing and they get the login page rather than a portal. The
  // org predicate is the tenancy guard on top of it — (org_id, lower(email)) is
  // unique, so at most one contact can match.
  const contact = redactInternal(
    await c.env.DB.prepare(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.salutation, c.honorific,
              c.pronouns, c.gender, c.mobile_phone, c.links,
              ec.biography, ec.headshot_asset_id, ec.company, ec.job_title
         FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?1
        WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?1)
          AND lower(c.email) = lower(?2)`,
    )
      .bind(event.id, session.email ?? '')
      .first<ContactRow>(),
  );
  if (!contact) return c.html(loginPage(event), 401);
  // Defect #12: the profile bio (event_contacts.biography, above) and the
  // biography a speaker typed into a submission's Participant step
  // (submission_participants.answers_json, keyed by that form's biography
  // question) are two different stores that are *supposed* to merge back
  // together at submit time (participants.ts's bioMerge). When they don't —
  // a draft never promoted, a participant added through a path that skips
  // the merge, data seeded directly — the portal warned "bio missing" even
  // though the speaker plainly supplied one. Rather than chase every write
  // path that could leave the two out of sync, fall back to the newest
  // submission-participant bio for this contact/event and backfill the
  // profile with it so the warning (and the profile view) tell the truth.
  if (!contact.biography) {
    const fallback = await findSubmissionParticipantBio(c.env.DB, event.id, contact.id);
    if (fallback) {
      contact.biography = fallback;
      await c.env.DB.prepare(
        `UPDATE event_contacts SET biography = ? WHERE event_id = ? AND contact_id = ? AND (biography IS NULL OR biography = '')`,
      )
        .bind(fallback, event.id, contact.id)
        .run();
    }
  }
  // One extra query per portal render, for the header switcher. Gated on a real
  // relationship rather than roster membership — see getPortalEvents.
  const portalEvents = await getPortalEvents(c.env.DB, { email: contact.email, eventId: event.id });
  return { event, session, contactId: contact.id, contact, portalEvents };
}

/**
 * Newest non-empty biography a submission's Participant step captured for
 * this contact on this event, read back out of submission_participants'
 * answers_json (keyed by that submission's form's biography question id —
 * the same field every form's Participant step biography question resolves
 * to, per field_definitions.key = 'biography'). Returns null when the
 * contact has never typed one anywhere.
 */
async function findSubmissionParticipantBio(db: D1Database, eventId: string, contactId: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT sp.answers_json, fq.id AS bio_question_id
         FROM submission_participants sp
         JOIN submissions s ON s.id = sp.submission_id
         JOIN form_questions fq ON fq.form_id = s.form_id AND fq.section = 'participant'
         JOIN field_definitions fd ON fd.id = fq.field_id AND fd.key = 'biography'
        WHERE sp.contact_id = ?1 AND s.event_id = ?2 AND sp.answers_json IS NOT NULL
        ORDER BY s.updated_at DESC
        LIMIT 10`,
    )
    .bind(contactId, eventId)
    .all<{ answers_json: string; bio_question_id: string }>();
  for (const row of results) {
    try {
      const answers = JSON.parse(row.answers_json) as Record<string, unknown>;
      const value = answers[row.bio_question_id];
      if (typeof value === 'string' && value.trim() !== '') return value;
    } catch {
      // malformed json for this row — try the next one
    }
  }
  return null;
}

const flashOf = (c: Context<AppEnv>): string | null => c.req.query('m') ?? null;

// ---------------------------------------------------------------------------
// Tasks data
// ---------------------------------------------------------------------------

interface TaskAssignmentRow {
  assignment_id: string;
  status: 'not_started' | 'in_progress' | 'complete';
  completed_at: string | null;
  submission_id: string | null;
  submission_code: string | null;
  submission_title: string | null;
  task_id: string;
  title: string;
  description: string | null;
  action_type: 'file_upload' | 'portal_form' | 'acknowledge' | 'external_link';
  portal_form_id: string | null;
  file_request_id: string | null;
  due_at: string | null;
  required: number;
}

// `t.event_id` is the event filter this list always meant: before 0015 a
// contact belonged to exactly one event, so ta.contact_id alone could not reach
// another event's tasks. Now that one contact spans the org it can, and the
// single-assignment read below already scopes the same way.
async function loadAssignments(
  c: Context<AppEnv>,
  eventId: string,
  contactId: string,
): Promise<TaskAssignmentRow[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT ta.id AS assignment_id, ta.status, ta.completed_at, ta.submission_id,
            s.code AS submission_code, s.title AS submission_title,
            t.id AS task_id, t.title, t.description, t.action_type,
            t.portal_form_id, t.file_request_id, t.due_at, t.required
     FROM task_assignments ta
     JOIN tasks t ON t.id = ta.task_id
     LEFT JOIN submissions s ON s.id = ta.submission_id
     WHERE ta.contact_id = ? AND t.event_id = ?
     ORDER BY CASE ta.status WHEN 'complete' THEN 1 ELSE 0 END, t.due_at`,
  )
    .bind(contactId, eventId)
    .all<TaskAssignmentRow>();
  return results;
}

const isOverdue = (t: TaskAssignmentRow): boolean =>
  t.status !== 'complete' && t.due_at !== null && new Date(t.due_at).getTime() < Date.now();

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

portalRoutes.get('/:slug', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${esc(ctx.event.slug)}`;

  const db = createDb(c.env.DB);
  const [submissions, assignments] = await Promise.all([
    db.submissions.listByContact(ctx.event.id, ctx.contactId),
    loadAssignments(c, ctx.event.id, ctx.contactId),
  ]);

  const subCards =
    submissions.length === 0
      ? '<p class="muted">You have not submitted anything yet.</p>'
      : submissions
          .slice(0, 5)
          .map(
            (s) => `<a class="sub-card" href="${base}/submissions/${esc(s.id)}">
<div class="t1"><span class="code">${esc(s.code)}</span> — ${esc(s.title)}</div>
<div class="t2">${esc(s.format ?? '')}</div>
<div style="margin-top:.3rem">${statusChipHtml(s.status)}</div></a>`,
          )
          .join('');

  const open = assignments.filter((t) => t.status !== 'complete');
  const overdueCount = open.filter(isOverdue).length;
  const taskSummary =
    assignments.length === 0
      ? '<p class="muted">No tasks found.</p>'
      : `<p>${open.length} open task${open.length === 1 ? '' : 's'}${
          overdueCount > 0 ? ` — <strong style="color:var(--danger-strong)">${overdueCount} overdue</strong>` : ''
        }.</p>
${open
  .slice(0, 4)
  .map(
    (t) => `<div class="task"><div class="t-head"><span class="t-title">${esc(t.title)}</span>
${t.due_at ? `<span class="due${isOverdue(t) ? ' overdue' : ''}">Due ${esc(fmtDate(t.due_at))}</span>` : ''}
<a class="btn secondary" style="padding:.25rem .7rem;font-size:.82rem" href="${base}/tasks#a-${esc(t.assignment_id)}">Open</a>
</div></div>`,
  )
  .join('')}`;

  return c.html(
    portalPage(
      ctx,
      'home',
      `<div class="grid2">
<div>
<div class="card"><h2>My Submissions <span class="count">${submissions.length}</span><a href="${base}/submissions">View All</a></h2>${subCards}</div>
</div>
<div>
<div class="card"><h2>My Profile</h2>
<p>${esc(displayName(ctx.contact))}<br><span class="muted small">${esc(ctx.contact.email)}</span></p>
${profileGapNotice(ctx, base)}
<a href="${base}/profile">View more</a></div>
<div class="card"><h2>Tasks <a href="${base}/tasks">View All</a></h2>${taskSummary}</div>
</div>
</div>`,
      flashOf(c),
    ),
  );
});

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

portalRoutes.get('/:slug/submissions', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${esc(ctx.event.slug)}`;

  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.code, s.title, s.status, s.format, s.created_at, s.updated_at,
            f.internal_name AS form_name
     FROM submissions s
     LEFT JOIN submission_forms f ON f.id = s.form_id
     WHERE s.event_id = ? AND (s.submitter_contact_id = ?
       OR EXISTS (SELECT 1 FROM submission_participants sp WHERE sp.submission_id = s.id AND sp.contact_id = ?))
     ORDER BY s.created_at DESC`,
  )
    .bind(ctx.event.id, ctx.contactId, ctx.contactId)
    .all<{ id: string; code: string; title: string; status: string; format: string | null; created_at: string; updated_at: string; form_name: string | null }>();

  const rows =
    results.length === 0
      ? '<p class="muted">You have not submitted anything yet.</p>'
      : results
          .map(
            (s) => `<a class="sub-card" href="${base}/submissions/${esc(s.id)}">
<div class="t1"><span class="code">${esc(s.code)}</span> — ${esc(s.title)}</div>
<div class="t2">${esc(s.form_name ?? 'Manual')} · Submitted ${esc(fmtDate(s.created_at))} · Updated ${esc(fmtDate(s.updated_at))}</div>
<div style="margin-top:.3rem">${statusChipHtml(s.status)}</div></a>`,
          )
          .join('');

  return c.html(portalPage(ctx, 'submissions', `<div class="card"><h2>My Submissions <span class="count">${results.length}</span></h2>${rows}</div>`, flashOf(c)));
});

portalRoutes.get('/:slug/submissions/:id', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${esc(ctx.event.slug)}`;
  const id = c.req.param('id');

  const submission = redactInternal(
    await c.env.DB.prepare(
      `SELECT s.*, t.name AS track_name, r.name AS room_name FROM submissions s
       LEFT JOIN tracks t ON t.id = s.track_id
       LEFT JOIN rooms r ON r.id = s.room_id
       WHERE s.id = ? AND s.event_id = ? AND (s.submitter_contact_id = ?
         OR EXISTS (SELECT 1 FROM submission_participants sp WHERE sp.submission_id = s.id AND sp.contact_id = ?))`,
    )
      .bind(id, ctx.event.id, ctx.contactId, ctx.contactId)
      .first<Record<string, unknown>>(),
  );
  if (!submission) return c.redirect(`${base}/submissions`);

  // F4 (eval sweep, missed by the first pass): the speaker portal showed
  // format/track/description/participants but never told an accepted
  // speaker *when or where* they were on — the same starts_at/ends_at/
  // room_id the public agenda (landing.tsx) already reads off the
  // submission row. Gate on the exact flag the public feed gates on
  // (`events.agenda_published === 1`) plus the session actually being
  // scheduled (accepted + both timestamps set, same as the public feed's
  // `status = 'accepted' AND starts_at IS NOT NULL AND ends_at IS NOT NULL`
  // predicate) so a speaker never sees a time the public agenda doesn't
  // also show yet. Accepted-but-not-yet-scheduled gets a "Scheduling TBC"
  // line instead; non-accepted statuses show neither.
  // `pencilled_at != null` means the auto-schedule assistant proposed this
  // slot and no organiser has confirmed it yet (AIA-08) — the public feed
  // excludes it, so the portal must too, or a speaker would read a time that
  // is still being moved around. Those fall through to "Scheduling TBC".
  const isScheduled =
    submission.status === 'accepted' &&
    submission.starts_at != null &&
    submission.ends_at != null &&
    submission.pencilled_at == null;
  const schedulingHtml =
    ctx.event.agenda_published === 1 && isScheduled
      ? `<dt>When</dt><dd>${esc(fmtDateRange(String(submission.starts_at), String(submission.ends_at), ctx.event.timezone))}</dd>${
          submission.room_name ? `<dt>Room</dt><dd>${esc(String(submission.room_name))}</dd>` : ''
        }`
      : submission.status === 'accepted'
        ? `<dt>When</dt><dd class="muted">Scheduling TBC</dd>`
        : '';

  const [{ results: answers }, { results: participants }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(q.label, f.label) AS label, a.value_json, q.position
       FROM submission_answers a
       JOIN form_questions q ON q.id = a.question_id
       JOIN field_definitions f ON f.id = q.field_id
       WHERE a.submission_id = ? ORDER BY q.position`,
    )
      .bind(id)
      .all<{ label: string; value_json: string | null }>(),
    c.env.DB.prepare(
      `SELECT c.first_name, c.last_name, c.email, sp.role, sp.is_primary_contact
       FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ? ORDER BY sp.position`,
    )
      .bind(id)
      .all<{ first_name: string | null; last_name: string | null; email: string; role: string; is_primary_contact: number }>(),
  ]);

  const answerValue = (json: string | null): string => {
    if (!json) return '—';
    try {
      const v = JSON.parse(json) as unknown;
      // An unanswered optional question stores the JSON literal `null` (and a
      // cleared number can store `""`). String(null) is the four characters
      // "null", which is what the speaker-facing detail page was printing at
      // the reader — an em-dash is the same "nothing here" the missing-row
      // case already renders.
      if (v === null || v === undefined) return '—';
      if (Array.isArray(v)) return v.length > 0 ? v.join(', ') : '—';
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '—';
      return String(v).replace(/<[^>]*>/g, '').trim() || '—';
    } catch {
      return json;
    }
  };

  const canWithdraw =
    submission.status !== 'withdrawn' && submission.status !== 'declined' &&
    submission.submitter_contact_id === ctx.contactId;
  // Editing stays open for every participant until the submission is
  // withdrawn or declined (docs/05 §4); organisers are notified afterwards.
  // It also closes when the form's own submission window closes, same as
  // resolveEditTarget enforces server-side — keep the Edit link's presence
  // consistent with what a click on it would actually allow.
  const canEdit =
    !isEditLocked(String(submission.status)) &&
    !(await isSubmissionFormClosed(c, ctx, (submission.form_id as string | null) ?? null));

  return c.html(
    portalPage(
      ctx,
      'submissions',
      `<div class="card">
<h2><span class="code">${esc(String(submission.code))}</span> ${esc(String(submission.title))} ${statusChipHtml(String(submission.status))}</h2>
<dl class="detail">
${submission.format ? `<dt>Format</dt><dd>${esc(String(submission.format))}</dd>` : ''}
${submission.track_name ? `<dt>Track</dt><dd>${esc(String(submission.track_name))}</dd>` : ''}
${schedulingHtml}
${submission.description ? `<dt>Description</dt><dd>${sanitizeRichHtml(String(submission.description)) ?? ''}</dd>` : ''}
${answers
  // The form's own "Title"/"Description"/"Format"/"Track" questions freeze
  // their answer text at submit time and would otherwise duplicate the
  // canonical columns rendered above (title in the <h2>, format/track as
  // the DetailPairs immediately above this map) — same defect and fix as
  // the admin SubmissionDetailPanel. Conservative exact match (trim +
  // lowercase) so a differently-labelled question still shows through.
  // ...but only while the canonical column has something to show: with no
  // track_name the Track pair above is not rendered either, and suppressing
  // the raw answer too made the submitter's own chosen track disappear from
  // their submission entirely.
  .filter((a) => {
    const label = a.label.trim().toLowerCase();
    if (label === 'track') return !submission.track_name;
    if (label === 'format') return !submission.format;
    if (label === 'title') return !submission.title;
    if (label === 'description') return !submission.description;
    return true;
  })
  .map((a) => `<dt>${esc(a.label)}</dt><dd>${esc(answerValue(a.value_json))}</dd>`)
  .join('')}
</dl>
</div>
<div class="card"><h2>Participants</h2>
${participants
  .map(
    (p) =>
      `<p>${esc([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email)} <span class="muted small">· ${esc(p.role)}${p.is_primary_contact === 1 ? ' · primary contact' : ''}</span></p>`,
  )
  .join('')}
</div>
${
  canWithdraw
    ? `<form method="post" action="${base}/submissions/${esc(id)}/withdraw" onsubmit="return confirm('Withdraw this submission? Organisers will see it as withdrawn.')">
<button class="danger" type="submit">Withdraw submission</button></form>`
    : ''
}
${
  canEdit
    ? `<p style="margin-top:.8rem"><a class="btn secondary" href="${base}/submissions/${esc(id)}/edit">Edit submission</a></p>
<p class="small muted">Changes are saved straight away; if a decision has already been made the organisers are notified.</p>`
    : '<p class="small muted" style="margin-top:.8rem">This submission can no longer be edited. Contact the organisers if something needs to change.</p>'
}`,
      flashOf(c),
    ),
  );
});

portalRoutes.post('/:slug/submissions/:id/withdraw', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const id = c.req.param('id');
  await c.env.DB.prepare(
    `UPDATE submissions SET status = 'withdrawn', updated_at = ?
     WHERE id = ? AND event_id = ? AND submitter_contact_id = ? AND status NOT IN ('withdrawn', 'declined')`,
  )
    .bind(new Date().toISOString(), id, ctx.event.id, ctx.contactId)
    .run();
  return c.redirect(`${base}/submissions/${id}?m=${encodeURIComponent('Submission withdrawn.')}`);
});

// ---------------------------------------------------------------------------
// Profile (docs/05 §5)
// ---------------------------------------------------------------------------

const PRONOUN_OPTIONS = ['', 'they/them', 'she/her', 'he/him', 'prefer not to say', 'self-describe'];

/** Link controls and the `links` json keys they map onto. */
const LINK_FIELDS = [
  ['link_linkedin', 'linkedin', 'LinkedIn URL'],
  ['link_twitter', 'twitter', 'X (Twitter) handle or URL'],
  ['link_facebook', 'facebook', 'Facebook URL'],
  ['link_website', 'website', 'Website'],
] as const;

type ProfileValues = Record<string, string>;

function parseLinks(json: string | null): Record<string, string> {
  try {
    const parsed = json ? (JSON.parse(json) as unknown) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Stored biographies can be HTML: the CFP participant step's biography field
 * is a wysiwyg question, and imports bring rich-text bios in verbatim — but
 * the Profile form edits the bio in a plain <textarea>, which was showing the
 * markup to the speaker character-for-character ("<p>…</p>"). Convert HTML to
 * clean text on the way INTO the textarea; the save path then stores exactly
 * the plain text the speaker sees, which every read surface already handles
 * (the public widgets' toParagraphs treats blank lines as paragraph breaks —
 * which is what block boundaries become here — and stripHtml is a no-op on
 * plain text). A bio that is already plain text passes through untouched, so
 * an unedited round trip cannot double-convert, escape or empty anything.
 */
function htmlBioToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|ul|ol)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Only values that actually contain markup are converted — plain text (the
 *  overwhelmingly common case after a first save) is returned verbatim. */
export function bioForEditing(stored: string | null): string {
  const value = stored ?? '';
  return /<[a-z!/][^>]*>/i.test(value) ? htmlBioToText(value) : value;
}

function profileValuesFromContact(contact: ContactRow): ProfileValues {
  const links = parseLinks(contact.links);
  const values: ProfileValues = {
    biography: bioForEditing(contact.biography),
    salutation: contact.salutation ?? '',
    first_name: contact.first_name ?? '',
    last_name: contact.last_name ?? '',
    honorific: contact.honorific ?? '',
    pronouns: contact.pronouns ?? '',
    company: contact.company ?? '',
    job_title: contact.job_title ?? '',
  };
  for (const [control, key] of LINK_FIELDS) values[control] = links[key] ?? '';
  return values;
}

function profilePageHtml(ctx: PortalCtx, values: ProfileValues, errors: FieldError[], flash: string | null): string {
  const base = `/portal/${esc(ctx.event.slug)}`;
  const contact = ctx.contact;
  const field = (name: string, label: string, type = 'text', required = false) =>
    `<label for="${esc(fieldId(name))}">${label}</label><input type="${type}" id="${esc(fieldId(name))}" name="${name}" value="${esc(
      values[name] ?? '',
    )}"${required ? ' required' : ''}${invalidAttrs(errors, name)}>${fieldErrorHtml(errors, name)}`;

  return portalPage(
    ctx,
    'profile',
    `${errorSummaryHtml(errors)}<form method="post" action="${base}/profile" enctype="multipart/form-data">
<div class="grid2">
<div class="card"><h2>General</h2>
<label for="${esc(fieldId('biography'))}">Biography <span class="counter" id="bio-count"></span></label>
<textarea id="${esc(fieldId('biography'))}" name="biography" rows="7" maxlength="5000"${invalidAttrs(
      errors,
      'biography',
    )}>${esc(values.biography ?? '')}</textarea>${fieldErrorHtml(errors, 'biography')}
${field('salutation', 'Salutation')}
${field('first_name', 'First Name *', 'text', true)}
${field('last_name', 'Last Name *', 'text', true)}
${field('honorific', 'Honorific')}
<label for="${esc(fieldId('pronouns'))}">Pronouns</label>
<select id="${esc(fieldId('pronouns'))}" name="pronouns"${invalidAttrs(errors, 'pronouns')}>${PRONOUN_OPTIONS.map(
      (p) => `<option value="${esc(p)}"${(values.pronouns ?? '') === p ? ' selected' : ''}>${esc(p || '\u2014')}</option>`,
    ).join('')}</select>${fieldErrorHtml(errors, 'pronouns')}
${field('company', 'Company')}
${field('job_title', 'Job title')}
<label for="${esc(fieldId('headshot'))}">Headshot <span class="muted small">(square works best, max 5 MB)</span></label>
${contact.headshot_asset_id ? `<img class="headshot-preview" src="/files/${esc(contact.headshot_asset_id)}" alt="Current headshot">` : ''}
<input type="file" id="${esc(fieldId('headshot'))}" name="headshot" accept="image/*"${invalidAttrs(errors, 'headshot')}>
${fieldErrorHtml(errors, 'headshot')}
</div>
<div class="card"><h2>My Links</h2>
${LINK_FIELDS.map(([control, , label]) => field(control, label, control === 'link_twitter' ? 'text' : 'url')).join('\n')}
<p style="margin-top:1.2rem"><button type="submit">Save profile</button></p>
</div>
</div>
</form>
<script>
const bio=document.getElementById('field-biography'),count=document.getElementById('bio-count');
const upd=()=>{count.textContent=bio.value.length.toLocaleString()+' / 5,000 characters'};
bio.addEventListener('input',upd);upd();
</script>`,
    flash,
  );
}

// SPK-10 fix: mirrors adminApi.ts's ensureHeadshotFileRequestId. A headshot
// saved through filestore.ts's saveFile only produces a file_assets row (plus
// the contacts.headshot_asset_id pointer) — the Files library query
// (filesAdminRoutes.get('/library')) reads file_request_uploads joined onto
// file_assets, so without a matching upload row the headshot never appeared
// there. Every event gets one standing "Headshots" file_requests row
// (deterministic id, INSERT OR IGNORE so concurrent first-uploads can't
// race), and each save is registered as a version in that contact's chain via
// fileVersions.ts's existing appendUploadVersion — same helper the
// file-request upload flow already uses, so a self-service headshot shows up
// in the library with filename/size/uploader/timestamp and the existing
// /files/:id view/download link, no schema migration required.
async function ensureHeadshotFileRequestId(db: D1Database, eventId: string): Promise<string> {
  const id = `file-request-headshots-${eventId}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO file_requests (id, event_id, title, type, created_at)
       VALUES (?, ?, 'Headshots', 'contacts', ?)`,
    )
    .bind(id, eventId, new Date().toISOString())
    .run();
  return id;
}

// Same shape as the headshot fix above, for *bare* file_upload tasks (no
// file_requests row): a task upload saved through saveFile used to produce
// only a file_assets row plus task_assignments.response_id — invisible to the
// Files library, which reads file_request_uploads. Every such task gets one
// standing file_requests row (deterministic id, INSERT OR IGNORE so two
// concurrent first-uploads can't race) and each upload is appended as a
// version in the speaker's chain, so a portal deliverable always lands in
// Workspace > Files with the full version history.
/**
 * CNT-13: the one accepted session this contact has in this event, or null
 * when they have none or more than one. Deliberately the same rule (and the
 * same ambiguity guard) as step 3 of filesAdmin.ts's RESOLVED_SUBMISSION_ID,
 * so a stamped upload and an unstamped one resolve to the same session —
 * stamping is an optimisation of the read, never a different answer.
 */
export async function soleAcceptedSessionId(
  db: D1Database,
  eventId: string,
  contactId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MIN(s.id) AS id FROM submissions s
        WHERE s.event_id = ? AND s.status = 'accepted'
          AND (s.submitter_contact_id = ?
               OR EXISTS (SELECT 1 FROM submission_participants sp
                           WHERE sp.submission_id = s.id AND sp.contact_id = ?))
       HAVING COUNT(*) = 1`,
    )
    .bind(eventId, contactId, contactId)
    .first<{ id: string | null }>();
  return row?.id ?? null;
}

export async function ensureTaskFileRequestId(
  db: D1Database,
  eventId: string,
  taskId: string,
  taskTitle: string,
): Promise<string> {
  const id = `file-request-task-${taskId}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO file_requests (id, event_id, title, type, created_at)
       VALUES (?, ?, ?, 'contacts', ?)`,
    )
    .bind(id, eventId, taskTitle.slice(0, 200) || 'Task upload', new Date().toISOString())
    .run();
  return id;
}

portalRoutes.get('/:slug/profile', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  return c.html(profilePageHtml(ctx, profileValuesFromContact(ctx.contact), [], flashOf(c)));
});

portalRoutes.post('/:slug/profile', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const body = await c.req.parseBody();

  const raw = (name: string): string => {
    const v = body[name];
    return typeof v === 'string' ? v.trim() : '';
  };
  const nullable = (name: string): string | null => raw(name) || null;

  // Echo everything the speaker typed, whatever happens next.
  const values: ProfileValues = {
    biography: raw('biography'),
    salutation: raw('salutation'),
    first_name: raw('first_name'),
    last_name: raw('last_name'),
    honorific: raw('honorific'),
    pronouns: raw('pronouns'),
    company: raw('company'),
    job_title: raw('job_title'),
  };
  for (const [control] of LINK_FIELDS) {
    const posted = raw(control);
    // The X/Twitter control accepts a bare handle as well as a full URL;
    // normalize it to a URL up front so both validation and the stored
    // value (and the echoed form on a validation error) see the same shape.
    values[control] = control === 'link_twitter' ? normalizeXHandleToUrl(posted) : posted;
  }

  const errors: FieldError[] = [];
  if (!values.first_name) errors.push({ key: 'first_name', message: 'First name is required.' });
  if (!values.last_name) errors.push({ key: 'last_name', message: 'Last name is required.' });
  for (const [control, , label] of LINK_FIELDS) {
    const value = values[control] ?? '';
    if (value !== '' && !isValidUrlShape(value)) {
      const message =
        control === 'link_twitter'
          ? `${label} must be a handle (e.g. @name) or a full http:// or https:// address.`
          : `${label} must be a full http:// or https:// address.`;
      errors.push({ key: control, message });
    }
  }
  if (errors.length > 0) return c.html(profilePageHtml(ctx, values, errors, null), 400);

  let headshotId = ctx.contact.headshot_asset_id;
  const upload = body.headshot;
  if (upload instanceof File && upload.size > 0) {
    const saved = await saveFile(c.env, {
      eventId: ctx.event.id,
      uploadedByContactId: ctx.contactId,
      file: upload,
      maxBytes: MAX_HEADSHOT_BYTES,
      allowedTypes: IMAGE_TYPES,
    });
    if ('error' in saved) {
      return c.html(profilePageHtml(ctx, values, [{ key: 'headshot', message: saved.error }], null), 400);
    }
    headshotId = saved.id;
    const fileRequestId = await ensureHeadshotFileRequestId(c.env.DB, ctx.event.id);
    await appendUploadVersion(
      c.env.DB,
      { fileRequestId, contactId: ctx.contactId, submissionId: null },
      { assetId: saved.id, uploadedAt: new Date().toISOString() },
    );
  }

  // Only touch `links` when the form actually carried the controls and the
  // result differs — a page that omits them (or leaves all four blank when
  // they were already blank) must not overwrite what is stored.
  const posted: Record<string, string> = {};
  for (const [control, key] of LINK_FIELDS) posted[key] = values[control] ?? '';
  const current = parseLinks(ctx.contact.links);
  const linksPresent = LINK_FIELDS.some(([control]) => control in body);
  const linksUnchanged = LINK_FIELDS.every(([, key]) => (current[key] ?? '') === posted[key]);
  const writeLinks = linksPresent && !linksUnchanged;

  // One form, two tables since 0015: the name/pronoun/links half is who the
  // person is across the org, the bio/company/job-title/headshot half is how
  // they present AT this event. Batched so a save can never land half of a
  // profile. The event_contacts UPDATE needs no upsert — loadPortalCtx only
  // returns a ctx when the membership row exists.
  const now = new Date().toISOString();
  const identitySql = `UPDATE contacts SET salutation = ?, first_name = ?, last_name = ?, honorific = ?,
       pronouns = ?${writeLinks ? ', links = ?' : ''}, updated_at = ?
     WHERE id = ?`;
  const identityBinds: unknown[] = [
    nullable('salutation'),
    values.first_name,
    values.last_name,
    nullable('honorific'),
    nullable('pronouns'),
  ];
  if (writeLinks) identityBinds.push(JSON.stringify(posted));
  identityBinds.push(now, ctx.contactId);
  // Wave E (workplan 14, D8): profile history. ctx.contact is still the row as
  // loadPortalCtx read it, so it IS the pre-edit snapshot — recorded only when
  // a watched field (bio/company/job title) actually changes, batched with the
  // UPDATE it precedes, mirroring this file's submission-edit path above.
  const incomingProfile = {
    biography: nullable('biography'),
    company: nullable('company'),
    job_title: nullable('job_title'),
  };
  const beforeProfile = {
    biography: ctx.contact.biography,
    company: ctx.contact.company,
    job_title: ctx.contact.job_title,
  };
  const profileStatements: D1PreparedStatement[] = [];
  if (watchedFieldsChanged(beforeProfile, incomingProfile, ['biography', 'company', 'job_title'])) {
    profileStatements.push(
      entityRevisionInsert(c.env.DB, {
        eventId: ctx.event.id,
        entityType: 'contact',
        entityId: ctx.contactId,
        payload: beforeProfile,
        editedBy: ctx.contactId,
        editedByName: displayName(ctx.contact),
        source: 'portal',
        editedAt: now,
      }),
    );
  }
  await c.env.DB.batch([
    ...profileStatements,
    c.env.DB.prepare(identitySql).bind(...identityBinds),
    c.env.DB.prepare(
      `UPDATE event_contacts SET biography = ?, company = ?, job_title = ?, headshot_asset_id = ?
       WHERE event_id = ? AND contact_id = ?`,
    ).bind(
      nullable('biography'),
      nullable('company'),
      nullable('job_title'),
      headshotId,
      ctx.event.id,
      ctx.contactId,
    ),
  ]);
  // Bio/headshot feed the dashboard's asset-completeness widget — bump so the
  // cached payload can't keep reporting them missing after this save.
  await bumpEventRevision(c.env, ctx.event.id);
  return c.redirect(`${base}/profile?m=${encodeURIComponent('Profile saved.')}`);
});

// ---------------------------------------------------------------------------
// Tasks (docs/05 §3/§6)
// ---------------------------------------------------------------------------

interface PortalFormQuestion {
  id: string;
  label: string;
  type: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}

function parsePortalFormQuestions(json: string | null): PortalFormQuestion[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as PortalFormQuestion[];
    return Array.isArray(parsed) ? parsed.filter((q) => q && q.id && q.label) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Upload policy (FR-PORTAL-8): a task backed by a file request uses that
// request's allowed_types / max_size_mb; anything else falls back to the
// generic portal limits. Malware scanning of stored bytes stays deliberately
// out of scope this pass (see the note in routes/files.ts).
// ---------------------------------------------------------------------------

interface FileRequestPolicyRow {
  id: string;
  title: string;
  allowed_types: string | null;
  max_size_mb: number | null;
}

interface UploadPolicy {
  allowedTypes: Set<string>;
  maxBytes: number;
}

const TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/zip': 'ZIP',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

function uploadPolicyFor(request: FileRequestPolicyRow | null | undefined): UploadPolicy {
  let allowedTypes = DOCUMENT_TYPES;
  if (request?.allowed_types) {
    try {
      const parsed = JSON.parse(request.allowed_types) as unknown;
      if (Array.isArray(parsed)) {
        const types = parsed.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
        if (types.length > 0) allowedTypes = new Set(types);
      }
    } catch {
      // Malformed config must not lock the speaker out: generic list applies.
    }
  }
  const maxBytes =
    request && typeof request.max_size_mb === 'number' && request.max_size_mb > 0
      ? request.max_size_mb * 1024 * 1024
      : MAX_UPLOAD_BYTES;
  return { allowedTypes, maxBytes };
}

/** Human copy for the effective policy — never a hardcoded "max 20 MB". */
function describeUploadPolicy(policy: UploadPolicy): string {
  const labels = [...new Set([...policy.allowedTypes].map((t) => TYPE_LABELS[t] ?? t))];
  const mb = Math.max(1, Math.round(policy.maxBytes / 1024 / 1024));
  return `${labels.join(', ')} \u2014 max ${mb} MB`;
}

async function loadFileRequest(
  c: Context<AppEnv>,
  eventId: string,
  id: string,
): Promise<FileRequestPolicyRow | null> {
  return c.env.DB.prepare(
    'SELECT id, title, allowed_types, max_size_mb FROM file_requests WHERE id = ? AND event_id = ?',
  )
    .bind(id, eventId)
    .first<FileRequestPolicyRow>();
}

// ---------------------------------------------------------------------------
// File version chain + comment thread (lane W2-C). A file-request task is not
// "done" the moment the first file lands: decks get redrafted, and organisers
// leave notes on them. The upload control therefore survives completion, each
// upload appends a version, and every version stays individually downloadable
// through /files/:id (fileAuth matches the speaker on file_request_uploads.
// contact_id, which superseded rows still satisfy).
// ---------------------------------------------------------------------------

interface FileChain {
  versions: FileVersionRow[];
  comments: FileCommentRow[];
}

const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
};

/** Newest first, current version flagged; every row links to /files/:id. */
function versionListHtml(versions: FileVersionRow[]): string {
  if (versions.length === 0) return '';
  const rows = [...versions]
    .sort((a, b) => b.version - a.version)
    .map(
      (v) => `<li class="vrow">
<a href="/files/${esc(v.file_asset_id)}">${esc(v.filename)}</a>
<span class="vtag${v.is_current === 1 ? ' current' : ''}">v${v.version}${v.is_current === 1 ? ' · Current' : ''}</span>
<span class="vmeta">${esc(formatBytes(v.size_bytes))} · ${esc(fmtDateTime(v.uploaded_at))}</span>
</li>`,
    )
    .join('');
  return `<p class="small" style="margin:.2rem 0 0"><strong>Uploaded file${
    versions.length === 1 ? '' : ` — ${versions.length} versions`
  }</strong></p>
<ul class="vlist">${rows}</ul>`;
}

/**
 * One thread per chain, not per version: a comment is anchored to the version
 * it was written against (shown as "on v1") but stays in the same conversation
 * after a re-upload, so an organiser reply lands under the speaker's note
 * rather than in a thread the speaker has to go looking for.
 */
function threadHtml(base: string, chain: FileChain, errors: FieldError[]): string {
  const current = chain.versions.find((v) => v.is_current === 1) ?? chain.versions[chain.versions.length - 1];
  if (!current) return '';
  const multi = chain.versions.length > 1;
  const items =
    chain.comments.length === 0
      ? '<p class="small muted" style="margin:.2rem 0">No comments yet.</p>'
      : chain.comments
          .map(
            (m) => `<div class="cmt${m.author_role === 'speaker' ? '' : ' staff'}">
<div class="chead"><strong>${esc(m.author_name ?? 'Someone')}</strong>${
              m.author_role === 'speaker' ? '' : ' <span class="vtag">Organiser</span>'
            } · ${esc(fmtDateTime(m.created_at))}${multi ? ` · on v${m.version}` : ''}</div>
<div class="cbody">${esc(m.body)}</div></div>`,
          )
          .join('');
  return `<div class="thread">
<p class="small" style="margin:0 0 .3rem"><strong>Comments</strong> <span class="muted">(visible to the organisers)</span></p>
${items}
<form method="post" action="${base}/files/${esc(current.upload_id)}/comments">
<label for="${esc(fieldId('comment'))}" class="small">Add a comment</label>
<textarea id="${esc(fieldId('comment'))}" name="comment" rows="2" maxlength="${MAX_COMMENT_CHARS}"${invalidAttrs(
    errors,
    'comment',
  )} placeholder="e.g. Draft deck — final version coming Friday."></textarea>
${fieldErrorHtml(errors, 'comment')}
<p><button type="submit" class="secondary">Post comment</button></p>
</form></div>`;
}

interface TaskRenderOpts {
  portalForm: { title: string | null; questions: PortalFormQuestion[] } | null;
  policy: UploadPolicy;
  /** validation errors for *this* assignment only */
  errors: FieldError[];
  /** posted values for *this* assignment only, keyed by control name */
  posted: Record<string, string>;
  /** version chain + comment thread for a file-request task, when it has one */
  chain: FileChain | null;
}

/**
 * The upload control, shown for an open task and again once it is complete.
 * `hasVersions` only changes the wording: the POST target is the same, and the
 * server decides whether the file starts the chain or extends it.
 */
function uploadFormHtml(
  action: string,
  policy: UploadPolicy,
  errors: FieldError[],
  hasVersions: boolean,
): string {
  return `<form method="post" action="${action}" enctype="multipart/form-data">
<label for="${esc(fieldId('upload'))}">${hasVersions ? 'Upload a new version' : 'File'} <span class="muted small">(${esc(
    describeUploadPolicy(policy),
  )})</span></label>
<input type="file" id="${esc(fieldId('upload'))}" name="upload" required accept="${esc(
    [...policy.allowedTypes].join(','),
  )}"${invalidAttrs(errors, 'upload')}>
${fieldErrorHtml(errors, 'upload')}
<p><button type="submit">${hasVersions ? 'Upload new version' : 'Upload &amp; complete'}</button></p></form>`;
}

function taskActionHtml(base: string, t: TaskAssignmentRow, opts: TaskRenderOpts): string {
  const { portalForm, policy, errors, posted, chain } = opts;
  const action = `${base}/tasks/${esc(t.assignment_id)}/complete`;
  // A completed file-request task keeps its upload control: completion means
  // "we have something", not "you may never send a better version".
  if (t.status === 'complete') {
    if (t.action_type !== 'file_upload') {
      return `<p class="small muted">Completed ${esc(fmtDate(t.completed_at))}.</p>`;
    }
    return `<p class="small muted">Completed ${esc(fmtDate(t.completed_at))}.</p>
${chain ? versionListHtml(chain.versions) : ''}
${uploadFormHtml(action, policy, errors, chain !== null && chain.versions.length > 0)}
${chain ? threadHtml(base, chain, errors) : ''}`;
  }
  switch (t.action_type) {
    case 'acknowledge':
      return `<form method="post" action="${action}">
<label class="small" style="font-weight:400"><input type="checkbox" id="${esc(fieldId('agree'))}" name="agree" value="1" required${invalidAttrs(
        errors,
        'agree',
      )}> I have read and agree</label>
${fieldErrorHtml(errors, 'agree')}
<p><button type="submit">Confirm</button></p></form>`;
    case 'external_link': {
      const url = t.description?.match(/https?:\/\/\S+/)?.[0];
      return `<form method="post" action="${action}">
${url ? `<p><a class="btn secondary" href="${esc(url)}" target="_blank" rel="noopener">Open link</a></p>` : ''}
<p><button type="submit">Mark as done</button></p></form>`;
    }
    case 'file_upload':
      return uploadFormHtml(action, policy, errors, false);
    case 'portal_form': {
      if (!portalForm || portalForm.questions.length === 0) {
        return '<p class="small muted">This form is not available yet.</p>';
      }
      const fields = portalForm.questions
        .map((q) => {
          const key = `q_${q.id}`;
          const id = esc(fieldId(key));
          const req = q.required ? ' required' : '';
          const star = q.required ? ' *' : '';
          const aria = invalidAttrs(errors, key);
          const err = fieldErrorHtml(errors, key);
          const value = posted[key] ?? '';
          if (q.type === 'dropdown' && q.options) {
            return `<label for="${id}">${esc(q.label)}${star}</label>
<select id="${id}" name="${esc(key)}"${req}${aria}><option value="">Select\u2026</option>${q.options
              .map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`)
              .join('')}</select>${err}`;
          }
          if (q.type === 'checkbox') {
            return `<label class="small" style="font-weight:400"><input type="checkbox" id="${id}" name="${esc(
              key,
            )}" value="yes"${value !== '' ? ' checked' : ''}${req}${aria}> ${esc(q.label)}${star}</label>${err}`;
          }
          if (q.type === 'textarea') {
            return `<label for="${id}">${esc(q.label)}${star}</label><textarea id="${id}" name="${esc(
              key,
            )}" rows="3"${req}${aria}>${esc(value)}</textarea>${err}`;
          }
          return `<label for="${id}">${esc(q.label)}${star}</label><input type="${
            q.type === 'date' ? 'date' : 'text'
          }" id="${id}" name="${esc(key)}" value="${esc(value)}"${req}${aria}>${err}`;
        })
        .join('');
      return `<form method="post" action="${action}">${fields}<p><button type="submit">Submit &amp; complete</button></p></form>`;
    }
  }
}

interface TasksPageOpts {
  flash?: string | null;
  /** assignment whose form failed validation — errors/posted apply to it only */
  assignmentId?: string;
  errors?: FieldError[];
  posted?: Record<string, string>;
}

async function tasksPageHtml(c: Context<AppEnv>, ctx: PortalCtx, opts: TasksPageOpts = {}): Promise<string> {
  const base = `/portal/${esc(ctx.event.slug)}`;
  const assignments = await loadAssignments(c, ctx.event.id, ctx.contactId);
  const errors = opts.errors ?? [];
  const posted = opts.posted ?? {};

  // portal_form definitions for any form-backed tasks on the page
  const formIds = [...new Set(assignments.map((t) => t.portal_form_id).filter((v): v is string => v !== null))];
  const forms = new Map<string, { title: string | null; questions: PortalFormQuestion[] }>();
  for (const formId of formIds) {
    const row = await c.env.DB.prepare('SELECT title, questions FROM portal_forms WHERE id = ?')
      .bind(formId)
      .first<{ title: string | null; questions: string | null }>();
    if (row) forms.set(formId, { title: row.title, questions: parsePortalFormQuestions(row.questions) });
  }

  // file-request policies for any upload tasks on the page (FR-PORTAL-8)
  const requestIds = [...new Set(assignments.map((t) => t.file_request_id).filter((v): v is string => v !== null))];
  const requests = new Map<string, FileRequestPolicyRow>();
  for (const requestId of requestIds) {
    const row = await loadFileRequest(c, ctx.event.id, requestId);
    if (row) requests.set(requestId, row);
  }

  // Version chains + threads for the file-request tasks on this page. Loaded
  // per assignment (one page holds a handful of tasks at most); the chain is
  // keyed by request + contact + submission, matching what the POST appends to.
  const chains = new Map<string, FileChain>();
  for (const t of assignments) {
    if (t.action_type !== 'file_upload') continue;
    // A task with no file_requests row uploads into the standing per-task
    // request (`file-request-task-<taskId>`, ensureTaskFileRequestId above) —
    // read that chain the same way the organiser side does (filesAdmin.ts).
    const chainRequestId = t.file_request_id ?? `file-request-task-${t.task_id}`;
    const versions = await loadChainVersions(c.env.DB, {
      fileRequestId: chainRequestId,
      contactId: ctx.contactId,
      submissionId: t.submission_id,
    });
    if (versions.length === 0) continue;
    chains.set(t.assignment_id, { versions, comments: await loadThread(c.env.DB, versions) });
  }

  const renderTask = (t: TaskAssignmentRow): string => {
    const isTarget = t.assignment_id === opts.assignmentId;
    return `<div class="task" id="a-${esc(t.assignment_id)}">
<div class="t-head">
<span class="t-title">${esc(t.title)}${t.required === 1 ? ' <span class="muted small">(required)</span>' : ''}</span>
${t.due_at ? `<span class="due${isOverdue(t) ? ' overdue' : ''}">Due ${esc(fmtDate(t.due_at))}</span>` : ''}
${isOverdue(t) ? '<span class="badge-overdue">Overdue</span>' : ''}
<span class="t-status ${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span>
</div>
${t.description ? `<div class="small muted" style="margin-top:.3rem">${esc(t.description.replace(/<[^>]*>/g, ''))}</div>` : ''}
${t.submission_code ? `<div class="small muted">For <span class="code">${esc(t.submission_code)}</span> ${esc(t.submission_title ?? '')}</div>` : ''}
<div class="t-body">${taskActionHtml(base, t, {
      portalForm: t.portal_form_id ? forms.get(t.portal_form_id) ?? null : null,
      policy: uploadPolicyFor(t.file_request_id ? requests.get(t.file_request_id) ?? null : null),
      errors: isTarget ? errors : [],
      posted: isTarget ? posted : {},
      chain: chains.get(t.assignment_id) ?? null,
    })}</div>
</div>`;
  };

  const submissionTasks = assignments.filter((t) => t.submission_id !== null);
  const myTasks = assignments.filter((t) => t.submission_id === null);

  return portalPage(
    ctx,
    'tasks',
    `${errorSummaryHtml(errors)}<div class="card"><h2>Submission Tasks <span class="count">${submissionTasks.length}</span></h2>
${submissionTasks.length === 0 ? '<p class="muted">No submission tasks found.</p>' : submissionTasks.map(renderTask).join('')}
</div>
<div class="card"><h2>My Tasks <span class="count">${myTasks.length}</span></h2>
${myTasks.length === 0 ? '<p class="muted">No tasks found.</p>' : myTasks.map(renderTask).join('')}
</div>`,
    opts.flash ?? null,
  );
}

portalRoutes.get('/:slug/tasks', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  return c.html(await tasksPageHtml(c, ctx, { flash: flashOf(c) }));
});

portalRoutes.post('/:slug/tasks/:assignmentId/complete', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const assignmentId = c.req.param('assignmentId');
  const back = (msg: string) => c.redirect(`${base}/tasks?m=${encodeURIComponent(msg)}#a-${assignmentId}`);
  /** Field-level failure: re-render the tasks page with the input preserved. */
  const invalid = async (errors: FieldError[], posted: Record<string, string> = {}) =>
    c.html(await tasksPageHtml(c, ctx, { assignmentId, errors, posted }), 400);

  const row = await c.env.DB.prepare(
    `SELECT ta.id AS assignment_id, ta.status, ta.completed_at, ta.submission_id,
            NULL AS submission_code, NULL AS submission_title,
            t.id AS task_id, t.title, t.description, t.action_type,
            t.portal_form_id, t.file_request_id, t.due_at, t.required
     FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
     WHERE ta.id = ? AND ta.contact_id = ? AND t.event_id = ?`,
  )
    .bind(assignmentId, ctx.contactId, ctx.event.id)
    .first<TaskAssignmentRow>();
  if (!row) return back('!Task not found.');
  // A completed file-upload task stays open for new versions (lane W2-C);
  // every other action type is genuinely one-shot.
  const reupload = row.status === 'complete' && row.action_type === 'file_upload';
  if (row.status === 'complete' && !reupload) return back('Task already complete.');

  const ts = new Date().toISOString();
  let responseId: string | null = null;
  let newVersion = 0;

  if (row.action_type === 'file_upload') {
    const body = await c.req.parseBody();
    const upload = body.upload;
    if (!(upload instanceof File) || upload.size === 0) {
      return invalid([{ key: 'upload', message: 'Choose a file to upload.' }]);
    }
    // The file request, when there is one, sets the accepted types and size.
    const request = row.file_request_id ? await loadFileRequest(c, ctx.event.id, row.file_request_id) : null;
    const policy = uploadPolicyFor(request);
    const saved = await saveFile(c.env, {
      eventId: ctx.event.id,
      uploadedByContactId: ctx.contactId,
      file: upload,
      maxBytes: policy.maxBytes,
      allowedTypes: policy.allowedTypes,
    });
    if ('error' in saved) return invalid([{ key: 'upload', message: saved.error }]);
    responseId = saved.id;
    // Every task upload is registered as a version chain so it appears in the
    // organiser Files library (Workspace > Files). Tasks with no file_requests
    // row get a standing per-task request created on first upload.
    const chainRequestId =
      row.file_request_id ?? (await ensureTaskFileRequestId(c.env.DB, ctx.event.id, row.task_id, row.title));
    // CNT-13: the stock "Upload Session Presentation" task is targeted at the
    // CONTACT, so `ta.submission_id` is NULL and the upload landed in the
    // library with an empty SESSION column while the session's own Files tab
    // said no files had been uploaded — for the most ordinary upload there is.
    // When the speaker has exactly one accepted session in this event there is
    // nothing to guess, so stamp it; with two (or none) the column stays NULL
    // and the organiser links it by hand (PUT /files/uploads/:id/submission).
    const submissionId = row.submission_id ?? (await soleAcceptedSessionId(c.env.DB, ctx.event.id, ctx.contactId));
    // Appends version N+1 and demotes the previous current row in one batch.
    const appended = await appendUploadVersion(
      c.env.DB,
      {
        fileRequestId: chainRequestId,
        contactId: ctx.contactId,
        submissionId,
      },
      { assetId: saved.id, uploadedAt: ts },
    );
    newVersion = appended.version;
  } else if (row.action_type === 'acknowledge') {
    const body = await c.req.parseBody();
    if (body.agree !== '1') {
      return invalid([{ key: 'agree', message: 'Please tick the confirmation first.' }]);
    }
  } else if (row.action_type === 'portal_form') {
    if (!row.portal_form_id) return back('!This form is not available.');
    const form = redactInternal(
      await c.env.DB.prepare('SELECT * FROM portal_forms WHERE id = ?')
        .bind(row.portal_form_id)
        .first<{ id: string; name: string; questions: string | null; send_confirmation_email: number }>(),
    );
    if (!form) return back('!This form is not available.');
    const questions = parsePortalFormQuestions(form.questions);
    const body = await c.req.parseBody();
    const answers: Record<string, string> = {};
    const posted: Record<string, string> = {};
    const errors: FieldError[] = [];
    for (const q of questions) {
      const v = body[`q_${q.id}`];
      const value = typeof v === 'string' ? v.trim() : '';
      posted[`q_${q.id}`] = value;
      if (q.required && value === '') {
        errors.push({ key: `q_${q.id}`, message: `${q.label} is required.` });
        continue;
      }
      if (value !== '') answers[q.id] = value;
    }
    if (errors.length > 0) return invalid(errors, posted);
    responseId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO portal_form_responses (id, portal_form_id, contact_id, submission_id, answers, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(responseId, form.id, ctx.contactId, row.submission_id, JSON.stringify(answers), ts)
      .run();
    if (form.send_confirmation_email === 1) {
      await sendTemplated(c, {
        templateKey: 'portal_form_confirmation',
        eventId: ctx.event.id,
        contactId: ctx.contactId,
        toEmail: ctx.contact.email,
        entityId: responseId,
        context: {
          event: { name: ctx.event.name },
          speaker: { first_name: ctx.contact.first_name ?? 'there' },
          form: { name: form.name },
        },
      });
    }
  }
  // external_link needs no payload \u2014 the button press is the confirmation.

  // response_id always points at the newest bytes; completed_at records the
  // first completion, so a re-upload does not rewrite when the task was done.
  await c.env.DB.prepare(
    `UPDATE task_assignments
     SET status = 'complete', completed_at = COALESCE(completed_at, ?), response_id = ?
     WHERE id = ?`,
  )
    .bind(ts, responseId, assignmentId)
    .run();
  // Task state and (for uploads) the file record feed the dashboard's speaker
  // tracking; without a bump its ETag/KV cache would serve the pre-completion
  // snapshot for up to the cache TTL.
  await bumpEventRevision(c.env, ctx.event.id);
  if (reupload) {
    return back(newVersion > 1 ? `Version ${newVersion} uploaded.` : 'New version uploaded.');
  }
  return back('Task completed \u2014 thank you!');
});

// POST /:slug/files/:uploadId/comments \u2014 a speaker's note on one version of
// their own upload. Ownership is the upload row's contact_id, so a speaker can
// only comment on files they uploaded; organisers post to the admin endpoint
// and both sides read the same thread.
portalRoutes.post('/:slug/files/:uploadId/comments', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const uploadId = c.req.param('uploadId');
  const back = (msg: string) => c.redirect(`${base}/tasks?m=${encodeURIComponent(msg)}`);

  const upload = await c.env.DB.prepare(
    `SELECT u.id, u.file_asset_id, fa.event_id
     FROM file_request_uploads u
     JOIN file_assets fa ON fa.id = u.file_asset_id
     WHERE u.id = ? AND u.contact_id = ?`,
  )
    .bind(uploadId, ctx.contactId)
    .first<{ id: string; file_asset_id: string; event_id: string }>();
  if (!upload || upload.event_id !== ctx.event.id) return back('!File not found.');

  const body = await c.req.parseBody();
  const text = typeof body.comment === 'string' ? body.comment : '';
  const created = await addComment(c.env.DB, {
    eventId: ctx.event.id,
    uploadId: upload.id,
    assetId: upload.file_asset_id,
    authorContactId: ctx.contactId,
    authorRole: 'speaker',
    authorName: displayName(ctx.contact),
    body: text,
  });
  if (!created) return back('!Write a comment before posting.');
  return back('Comment posted.');
});

// ---------------------------------------------------------------------------
// Editing a submission (docs/Clarifications/Swyx-2 gap 2). Acceptance does not
// lock a proposal: any participant may keep it accurate until it is withdrawn
// or declined. Post-decision edits notify the organisers configured on the
// form (notify_admins_on_update), once per save.
// ---------------------------------------------------------------------------

const EDIT_LOCKED_STATUSES: ReadonlySet<string> = new Set(['withdrawn', 'declined']);

function isEditLocked(status: string): boolean {
  return EDIT_LOCKED_STATUSES.has(status);
}

/**
 * A submission's own status aside, its form can also close underneath it
 * (status flipped to 'closed', or close_at elapsed) — the same "closed"
 * rule the public wizard enforces (submit.tsx isFormClosed). Manual
 * submissions (form_id null) are never form-locked.
 */
async function isSubmissionFormClosed(c: Context<AppEnv>, ctx: PortalCtx, formId: string | null): Promise<boolean> {
  if (!formId) return false;
  const form = await c.env.DB.prepare('SELECT status, close_at FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(formId, ctx.event.id)
    .first<{ status: string; close_at: string | null }>();
  return form ? isFormClosed(form) : false;
}

interface EditableSubmissionRow {
  id: string;
  event_id: string;
  form_id: string | null;
  code: string;
  title: string;
  description: string | null;
  status: string;
  format: string | null;
  level: string | null;
  language: string | null;
  track_id: string | null;
  submitter_contact_id: string | null;
  updated_at: string;
}

/** The submission, but only when this speaker submitted it or participates. */
async function loadOwnSubmission(
  c: Context<AppEnv>,
  ctx: PortalCtx,
  id: string,
): Promise<EditableSubmissionRow | null> {
  return redactInternal(
    await c.env.DB.prepare(
      `SELECT s.* FROM submissions s
       WHERE s.id = ? AND s.event_id = ? AND (s.submitter_contact_id = ?
         OR EXISTS (SELECT 1 FROM submission_participants sp WHERE sp.submission_id = s.id AND sp.contact_id = ?))`,
    )
      .bind(id, ctx.event.id, ctx.contactId, ctx.contactId)
      .first<EditableSubmissionRow>(),
  );
}

/** Abstract-section questions split by audience (0042): `questions` is what
 *  the speaker sees and edits; `internalQuestionIds` are the organiser-only
 *  fields whose stored answers a portal save must leave untouched. */
async function loadAbstractQuestions(
  c: Context<AppEnv>,
  formId: string | null,
  eventId?: string,
): Promise<{ questions: QuestionDef[]; internalQuestionIds: string[] }> {
  if (!formId) return { questions: [], internalQuestionIds: [] };
  const all = (await loadQuestions(c.env.DB, formId, eventId)) as unknown as QuestionDef[];
  const abstract = all.filter((q) => q.section === 'abstract');
  return {
    questions: abstract.filter((q) => q.audience !== 'internal'),
    internalQuestionIds: abstract.filter((q) => q.audience === 'internal').map((q) => q.id),
  };
}

async function loadSubmissionAnswers(c: Context<AppEnv>, submissionId: string): Promise<Answers> {
  const { results } = await c.env.DB.prepare(
    'SELECT question_id, value_json FROM submission_answers WHERE submission_id = ?',
  )
    .bind(submissionId)
    .all<{ question_id: string; value_json: string | null }>();
  const out: Answers = {};
  for (const row of results) {
    if (row.value_json === null) continue;
    try {
      out[row.question_id] = JSON.parse(row.value_json) as AnswerValue;
    } catch {
      out[row.question_id] = row.value_json;
    }
  }
  return out;
}

const answerText = (v: AnswerValue): string =>
  v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v) ? '' : String(v);

const answerList = (v: AnswerValue): string[] =>
  Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === '' ? [] : [String(v)];

/**
 * Show-when visibility (docs/02 §3, docs/04 §3) is honoured on the edit page
 * the same way the create wizard honours it (CFP-02 fix): a field whose
 * `visibility` rule evaluates to hidden against the current answers is not
 * rendered at all on first paint (the wrapper below is server-filtered by
 * `visibleQuestionIds` in `editPageHtml`), and the inline script re-derives
 * visibility as the speaker edits controlling fields, without a page reload
 * — the portal is otherwise a plain POST/redirect surface (see file banner),
 * so this is the one bit of client JS the edit form needs. Hidden fields are
 * `disabled` client-side so they are excluded from the POST body entirely,
 * matching `discardHiddenAnswers` on the server: the existing established
 * convention (`forms.ts` — "Answers for hidden questions are discarded,
 * never stored") is that a field's stored answer is *dropped*, not kept,
 * the moment it is hidden and the form is saved — the same thing already
 * happens on every create-wizard submit. The edit page now matches that
 * exactly rather than inventing a "keep it around" rule of its own; if a
 * speaker flips Format to Workshop and back before saving, the workshop
 * duration they had typed is gone, same as it would be on a fresh
 * submission.
 */
function editControlHtml(q: QuestionDef, value: AnswerValue, errors: FieldError[], visible: boolean): string {
  const id = esc(fieldId(q.id));
  const name = esc(`q_${q.id}`);
  const aria = invalidAttrs(errors, q.id);
  const err = fieldErrorHtml(errors, q.id);
  const star = q.required ? ' *' : '';
  const help = q.help_text ? `<p class="qhelp">${esc(q.help_text)}</p>` : '';
  const label = `<label for="${id}">${esc(q.label)}${star}</label>`;
  const maxlen = q.max_chars ? ` maxlength="${q.max_chars}"` : '';
  const wrap = (inner: string) =>
    `<div class="qfield" id="${esc(`qwrap-${q.id}`)}"${visible ? '' : ' style="display:none"'}>${inner}</div>`;

  switch (q.type) {
    case 'heading':
      return wrap(`<h3 style="margin:1.2rem 0 .2rem;font-size:.95rem">${esc(q.label)}</h3>${help}`);
    case 'textarea':
    case 'wysiwyg':
      return wrap(
        `${label}<textarea id="${id}" name="${name}" rows="6"${maxlen}${aria}>${esc(answerText(value))}</textarea>${help}${err}`,
      );
    case 'dropdown':
      return wrap(
        `${label}<select id="${id}" name="${name}"${aria}><option value="">Select\u2026</option>${(q.options ?? [])
          .map(
            (o) =>
              `<option value="${esc(o.value)}"${o.value === answerText(value) ? ' selected' : ''}>${esc(o.label)}</option>`,
          )
          .join('')}</select>${help}${err}`,
      );
    case 'radio': {
      const chosen = answerText(value);
      const items = (q.options ?? [])
        .map(
          (o, idx) =>
            `<label class="small" style="font-weight:400"><input type="radio"${idx === 0 ? ` id="${id}"` : ''} name="${name}" value="${esc(
              o.value,
            )}"${o.value === chosen ? ' checked' : ''}${aria}> ${esc(o.label)}</label>`,
        )
        .join('');
      return wrap(`${label}${items}${help}${err}`);
    }
    case 'multiselect': {
      const chosen = new Set(answerList(value));
      const items = (q.options ?? [])
        .map(
          (o, idx) =>
            `<label class="small" style="font-weight:400"><input type="checkbox"${idx === 0 ? ` id="${id}"` : ''} name="${name}" value="${esc(
              o.value,
            )}"${chosen.has(o.value) ? ' checked' : ''}${aria}> ${esc(o.label)}</label>`,
        )
        .join('');
      return wrap(`${label}${items}${help}${err}`);
    }
    case 'checkbox':
      return wrap(
        `<label class="small" style="font-weight:400"><input type="checkbox" id="${id}" name="${name}" value="yes"${
          value === true || value === 'yes' ? ' checked' : ''
        }${aria}> ${esc(q.label)}${star}</label>${help}${err}`,
      );
    case 'file':
      return wrap(
        `${label}<p class="small muted">Uploaded files are managed from your Tasks page; the current attachment is left as it is.</p>${help}`,
      );
    default: {
      const type =
        q.type === 'number'
          ? 'number'
          : q.type === 'email'
            ? 'email'
            : q.type === 'url'
              ? 'url'
              : q.type === 'phone'
                ? 'tel'
                : q.type === 'date'
                  ? 'date'
                  : q.type === 'datetime'
                    ? 'datetime-local'
                    : 'text';
      return wrap(
        `${label}<input type="${type}" id="${id}" name="${name}" value="${esc(answerText(value))}"${maxlen}${aria}>${help}${err}`,
      );
    }
  }
}

/** One roster row as the edit page's Participants card needs it. */
interface EditParticipantRow {
  id: string;
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string;
  is_primary_contact: number;
}

/**
 * Participants card (ABS-11): the roster, each removable row's own tiny
 * confirm-then-POST form, and an "Add co-author" form \u2014 everything the
 * organiser-side ParticipantsEditor offers, minus role reordering, scoped to
 * what a speaker should be able to do to their own submission. Hidden add
 * form once the roster is already at MAX_PARTICIPANTS_PER_SUBMISSION, same
 * cap submit.tsx and the admin endpoint both enforce server-side.
 */
function participantsCardHtml(
  ctx: PortalCtx,
  submission: EditableSubmissionRow,
  participants: EditParticipantRow[],
  roleConfig: ParticipantRoleConfig[],
): string {
  const base = `/portal/${esc(ctx.event.slug)}`;
  const detail = `${base}/submissions/${esc(submission.id)}`;
  const rows = participants
    .map((p) => {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email;
      const removable = p.is_primary_contact !== 1 && p.contact_id !== ctx.contactId;
      const removeForm = removable
        ? `<form method="post" action="${detail}/edit/participants/${esc(p.id)}/remove" onsubmit="return confirm('Remove this participant?')" style="display:inline"><button class="danger" type="submit">Remove</button></form>`
        : '';
      return `<div class="vrow"><span>${esc(name)}</span><span class="vtag">${esc(p.role)}</span>${
        p.is_primary_contact === 1 ? '<span class="muted small">primary contact</span>' : ''
      }${removeForm}</div>`;
    })
    .join('');

  const atCap = participants.length >= MAX_PARTICIPANTS_PER_SUBMISSION;
  const roleOptions = roleConfig
    .map(
      (cfg) =>
        `<option value="${esc(cfg.role)}"${cfg.role === 'co-author' ? ' selected' : ''}>${esc(
          cfg.role.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
        )}</option>`,
    )
    .join('');
  const addForm = atCap
    ? `<p class="small muted">This submission has reached the maximum of ${MAX_PARTICIPANTS_PER_SUBMISSION} participants.</p>`
    : `<form method="post" action="${detail}/edit/participants/add" style="margin-top:.6rem">
<label for="p_first">First name</label><input type="text" id="p_first" name="p_first" required>
<label for="p_last">Last name</label><input type="text" id="p_last" name="p_last" required>
<label for="p_email">Email address</label><input type="email" id="p_email" name="p_email" required>
<label for="p_role">Role</label><select id="p_role" name="p_role">${roleOptions}</select>
<p style="margin-top:.6rem"><button type="submit">Add co-author</button></p>
</form>`;

  return `<div class="card"><h2>Participants</h2>
<div class="vlist">${rows}</div>
<h3 style="margin:1rem 0 .3rem;font-size:.9rem">Add co-author</h3>
${addForm}
</div>`;
}

function editPageHtml(
  ctx: PortalCtx,
  submission: EditableSubmissionRow,
  questions: QuestionDef[],
  answers: Answers,
  errors: FieldError[],
  flash: string | null,
  participants: EditParticipantRow[],
  roleConfig: ParticipantRoleConfig[],
): string {
  const base = `/portal/${esc(ctx.event.slug)}`;
  const detail = `${base}/submissions/${esc(submission.id)}`;
  const decided = submission.status === 'accepted' || submission.status === 'accept_queue' || submission.status === 'decline_queue';
  const visible = visibleQuestionIds(questions, answers);
  return portalPage(
    ctx,
    'submissions',
    `${errorSummaryHtml(errors)}<div class="card">
<h2><span class="code">${esc(submission.code)}</span> Edit submission ${statusChipHtml(submission.status)}</h2>
${decided ? '<p class="small muted">This submission already has a decision \u2014 the organisers are notified of any change you save.</p>' : ''}
<form method="post" action="${detail}/edit" id="edit-submission-form">
${questions.map((q) => editControlHtml(q, answers[q.id], errors, visible.has(q.id))).join('\n')}
<p style="margin-top:1.2rem"><button type="submit">Save changes</button>
<a class="btn secondary" style="margin-left:.5rem" href="${detail}">Cancel</a></p>
</form>
</div>
${participantsCardHtml(ctx, submission, participants, roleConfig)}
${editVisibilityScript(questions)}`,
    flash,
  );
}

/**
 * Re-evaluate show-when visibility client-side as the speaker edits a
 * controlling field, mirroring `visibleQuestionIds`/`evalRule` from
 * `@kms/core` (kept in sync by hand \u2014 this file has no bundler step to share
 * the module with, see the file banner's "island-free" note). A hidden
 * field's inputs are `disabled` so the browser excludes them from the POST
 * body, matching the server's `discardHiddenAnswers`; the field's own stored
 * value is untouched until (and unless) the speaker submits while it is
 * visible again.
 */
function editVisibilityScript(questions: QuestionDef[]): string {
  const withRules = questions.filter((q) => q.visibility !== null);
  if (withRules.length === 0) return '';
  const spec = questions.map((q) => ({ id: q.id, rule: q.visibility ?? null }));
  return `<script>
(function(){
var Q=${JSON.stringify(spec)};
function isEmpty(v){return v===undefined||v===null||v===false||(typeof v==='string'&&v.trim()==='')||(Array.isArray(v)&&v.length===0);}
function asArray(v){return Array.isArray(v)?v.map(String):isEmpty(v)?[]:[String(v)];}
function fieldValue(qid){
  var els=document.getElementsByName('q_'+qid);
  if(!els.length)return undefined;
  if(els[0].type==='checkbox'){
    if(els.length===1)return els[0].checked;
    var out=[];for(var i=0;i<els.length;i++){if(els[i].checked)out.push(els[i].value);}return out;
  }
  if(els[0].type==='radio'){
    for(var j=0;j<els.length;j++){if(els[j].checked)return els[j].value;}
    return undefined;
  }
  return els[0].value;
}
function evalCond(c,answers){
  var v=answers[c.question_id];
  switch(c.op){
    case 'equals':return asArray(v).length===1&&asArray(v)[0]===String(c.value);
    case 'not_equals':return !(asArray(v).length===1&&asArray(v)[0]===String(c.value));
    case 'contains':return asArray(v).indexOf(String(c.value))!==-1;
    case 'not_contains':return asArray(v).indexOf(String(c.value))===-1;
    case 'is_any_of':var wanted=Array.isArray(c.value)?c.value.map(String):[String(c.value)];return asArray(v).some(function(x){return wanted.indexOf(x)!==-1;});
    case 'is_empty':return isEmpty(v);
    case 'is_not_empty':return !isEmpty(v);
    case 'gt':return typeof v==='number'&&v>Number(c.value);
    case 'lt':return typeof v==='number'&&v<Number(c.value);
    default:return false;
  }
}
function evalRule(rule,answers){
  if(!rule.conditions||rule.conditions.length===0)return true;
  var results=rule.conditions.map(function(c){return evalCond(c,answers);});
  var matched=rule.match==='any'?results.some(Boolean):results.every(Boolean);
  return rule.action==='hide'?!matched:matched;
}
function recompute(){
  var effective={};
  Q.forEach(function(q){
    var vis=q.rule?evalRule(q.rule,effective):true;
    var wrap=document.getElementById('qwrap-'+q.id);
    if(wrap)wrap.style.display=vis?'':'none';
    var els=document.getElementsByName('q_'+q.id);
    for(var i=0;i<els.length;i++){els[i].disabled=!vis;}
    if(vis)effective[q.id]=fieldValue(q.id);
  });
}
var form=document.getElementById('edit-submission-form');
if(form){form.addEventListener('input',recompute);form.addEventListener('change',recompute);}
recompute();
})();
</script>`;
}

/** Read one posted edit form back into Answers, typed per question. */
function readEditAnswers(
  questions: QuestionDef[],
  body: Record<string, string | File | (string | File)[]>,
  existing: Answers,
): Answers {
  const out: Answers = {};
  for (const q of questions) {
    if (q.type === 'heading') continue;
    if (q.type === 'file') {
      // Not editable here: keep whatever the submission already carries.
      if (existing[q.id] !== undefined) out[q.id] = existing[q.id];
      continue;
    }
    const raw = body[`q_${q.id}`];
    if (q.type === 'multiselect') {
      const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      out[q.id] = list.filter((v): v is string => typeof v === 'string' && v !== '');
      continue;
    }
    const first = Array.isArray(raw) ? raw[0] : raw;
    const value = typeof first === 'string' ? first.trim() : '';
    if (q.type === 'checkbox') {
      out[q.id] = value !== '';
      continue;
    }
    if (q.type === 'number') {
      const n = Number(value);
      out[q.id] = value === '' ? null : Number.isNaN(n) ? value : n;
      continue;
    }
    out[q.id] = value;
  }
  return out;
}

/** System fields mirrored onto submission columns (docs/04 §5). */
function editSystemColumns(questions: QuestionDef[], answers: Answers): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const q of questions) {
    const value = answers[q.id];
    if (value === undefined) continue;
    const text = answerText(value).trim();
    switch (q.field_key) {
      case 'title':
        if (text !== '') out.title = text.slice(0, 255);
        break;
      case 'description':
      case 'format':
      case 'level':
      case 'language':
        out[q.field_key] = text === '' ? null : text;
        break;
      default:
        break;
    }
  }
  return out;
}

async function prepareAdminUpdateEmails(
  c: Context<AppEnv>,
  ctx: PortalCtx,
  submission: EditableSubmissionRow,
  title: string,
  version: string,
): Promise<PreparedEmail[]> {
  if (!submission.form_id) return [];
  const form = await c.env.DB.prepare(
    'SELECT notify_admins_on_update FROM submission_forms WHERE id = ? AND event_id = ?',
  )
    .bind(submission.form_id, ctx.event.id)
    .first<{ notify_admins_on_update: string | null }>();
  let ids: string[] = [];
  try {
    const parsed = form?.notify_admins_on_update ? (JSON.parse(form.notify_admins_on_update) as unknown) : [];
    if (Array.isArray(parsed)) ids = [...new Set(parsed.filter((v): v is string => typeof v === 'string' && v !== ''))];
  } catch {
    ids = [];
  }
  if (ids.length === 0) return [];

  // Recipients must be contacts of this event — configuration can go stale.
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.email FROM contacts c
      JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
     WHERE c.id IN (${placeholders})`,
  )
    .bind(ctx.event.id, ...ids)
    .all<{ id: string; email: string }>();

  const prepared: PreparedEmail[] = [];
  for (const recipient of results) {
    // version = the new updated_at, so one save produces exactly one message.
    const email = await prepareTemplated(c.env.DB, {
      templateKey: 'submission_updated_admin',
      eventId: ctx.event.id,
      contactId: recipient.id,
      toEmail: recipient.email,
      entityId: submission.id,
      version,
      context: {
        event: { name: ctx.event.name },
        submission: { title, code: submission.code },
        submitter: { name: displayName(ctx.contact), email: ctx.contact.email },
        admin_url: `${c.env.APP_URL}/app`,
      },
    });
    if (email) prepared.push(email);
  }
  return prepared;
}

/** The submission's roster, as the edit page's Participants card needs it. */
async function loadEditParticipants(c: Context<AppEnv>, submissionId: string): Promise<EditParticipantRow[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT sp.id, sp.contact_id, c.first_name, c.last_name, c.email, sp.role, sp.is_primary_contact
     FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
     WHERE sp.submission_id = ? ORDER BY sp.position`,
  )
    .bind(submissionId)
    .all<EditParticipantRow>();
  return results;
}

/** The role vocabulary this submission's form offers, same fallback as submit.tsx. */
async function loadParticipantRoleConfig(
  c: Context<AppEnv>,
  formId: string | null,
  eventId: string,
): Promise<ParticipantRoleConfig[]> {
  if (!formId) return parseParticipantRoles(null);
  const form = await c.env.DB.prepare('SELECT participant_roles FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(formId, eventId)
    .first<{ participant_roles: string | null }>();
  return parseParticipantRoles(form?.participant_roles ?? null);
}

/** Shared guard for both edit routes: 404 when it is not theirs, 403 when locked. */
async function resolveEditTarget(
  c: Context<AppEnv>,
  ctx: PortalCtx,
  id: string,
): Promise<
  | {
      submission: EditableSubmissionRow;
      questions: QuestionDef[];
      internalQuestionIds: string[];
      participants: EditParticipantRow[];
      roleConfig: ParticipantRoleConfig[];
    }
  | Response
> {
  const submission = await loadOwnSubmission(c, ctx, id);
  if (!submission) {
    return c.html(
      portalPage(
        ctx,
        'submissions',
        '<div class="card"><h2>Submission not found</h2><p class="muted">We could not find that submission on your account.</p></div>',
      ),
      404,
    );
  }
  if (isEditLocked(submission.status)) {
    return c.html(
      portalPage(
        ctx,
        'submissions',
        `<div class="card"><h2>Editing closed</h2><p class="muted">This submission is ${esc(
          submission.status,
        )} and can no longer be edited. Contact the organisers if something needs to change.</p></div>`,
      ),
      403,
    );
  }
  if (await isSubmissionFormClosed(c, ctx, submission.form_id)) {
    return c.html(
      portalPage(
        ctx,
        'submissions',
        '<div class="card"><h2>Editing closed</h2><p class="muted">The submission window for this form has closed. Contact the organisers if something needs to change.</p></div>',
      ),
      403,
    );
  }
  const { questions, internalQuestionIds } = await loadAbstractQuestions(c, submission.form_id, ctx.event.id);
  if (questions.length === 0) {
    return c.html(
      portalPage(
        ctx,
        'submissions',
        '<div class="card"><h2>Editing unavailable</h2><p class="muted">This submission has no editable form. Contact the organisers to make a change.</p></div>',
      ),
      403,
    );
  }
  const [participants, roleConfig] = await Promise.all([
    loadEditParticipants(c, submission.id),
    loadParticipantRoleConfig(c, submission.form_id, ctx.event.id),
  ]);
  return { submission, questions, internalQuestionIds, participants, roleConfig };
}

/**
 * Answers as the edit form's controls need them (portal defect,
 * live-reproduced 2026-08-12: the edit page rendered Track as "Select…"
 * while the read-only view showed the saved track — saving then silently
 * cleared it). Two mismatches are repaired here:
 *   - stored answers hold the track's *label* (submit.tsx storableAnswers),
 *     but the derived Track options are keyed by track id — normalised back
 *     to the id so the <select> hydrates;
 *   - seeded/imported submissions have no answer rows at all, only system
 *     columns — those columns are synthesized in as answers.
 */
function hydrateEditAnswers(
  questions: QuestionDef[],
  answers: Answers,
  submission: EditableSubmissionRow,
): Answers {
  return normaliseTrackAnswers(questions, synthesizeAnswersFromColumns(questions, answers, submission));
}

portalRoutes.get('/:slug/submissions/:id/edit', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const target = await resolveEditTarget(c, ctx, c.req.param('id'));
  if (target instanceof Response) return target;
  const answers = hydrateEditAnswers(
    target.questions,
    await loadSubmissionAnswers(c, target.submission.id),
    target.submission,
  );
  return c.html(
    editPageHtml(ctx, target.submission, target.questions, answers, [], flashOf(c), target.participants, target.roleConfig),
  );
});

portalRoutes.post('/:slug/submissions/:id/edit', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const id = c.req.param('id');
  const target = await resolveEditTarget(c, ctx, id);
  if (target instanceof Response) return target;
  const { submission, questions, internalQuestionIds, participants, roleConfig } = target;

  const body = await c.req.parseBody({ all: true });
  const existing = await loadSubmissionAnswers(c, submission.id);
  // Normalise before validating: the Track question's options are keyed by
  // track id, but a stale client (or a stored label echoed back) may post
  // the label — validateAnswers would reject it as "not one of the offered
  // options" even though it names a real track.
  const answers = normaliseTrackAnswers(questions, readEditAnswers(questions, body, existing));
  const errors: FieldError[] = validateAnswers(questions, answers).map((e) => ({
    key: e.question_id,
    message: e.message,
  }));
  if (errors.length > 0) {
    return c.html(editPageHtml(ctx, submission, questions, answers, errors, null, participants, roleConfig), 400);
  }

  const kept = discardHiddenAnswers(questions, answers);
  const sys = editSystemColumns(questions, kept);
  const title = sys.title ?? submission.title;

  // Track comes from its system question when the form has one, otherwise the
  // stored value stands. An EMPTY track answer keeps the stored value rather
  // than clearing it (portal defect: an unhydrated "Select…" used to wipe the
  // saved track on save). Validate it belongs to this event either way.
  const trackQuestion = questions.find((q) => q.field_key === 'track');
  let trackId = trackQuestion
    ? answerText(kept[trackQuestion.id]) || submission.track_id || null
    : submission.track_id;
  if (trackId) {
    const track = await c.env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND event_id = ?')
      .bind(trackId, ctx.event.id)
      .first<{ id: string }>();
    if (!track) trackId = null;
  }

  const updatedAt = new Date().toISOString();
  // Content history (CFP content-revisions): snapshot the PRE-edit
  // title/description — `submission` here is still the row as loaded by
  // resolveEditTarget, before this statement changes it — batched with the
  // update so history and the change it precedes commit together.
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO content_revisions
         (id, event_id, submission_id, title, description, edited_by, edited_by_name, source, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'portal', ?)`,
    ).bind(
      crypto.randomUUID(),
      ctx.event.id,
      submission.id,
      submission.title,
      submission.description,
      ctx.contact.id,
      displayName(ctx.contact),
      updatedAt,
    ),
    c.env.DB.prepare(
      `UPDATE submissions SET title = ?, description = ?, format = ?, level = ?, language = ?,
         track_id = ?, updated_at = ?
       WHERE id = ? AND event_id = ? AND status NOT IN ('withdrawn', 'declined')`,
    ).bind(
      title,
      'description' in sys ? sys.description : submission.description,
      'format' in sys ? sys.format : submission.format,
      'level' in sys ? sys.level : submission.level,
      'language' in sys ? sys.language : submission.language,
      trackId,
      updatedAt,
      submission.id,
      ctx.event.id,
    ),
    // Internal-audience questions (0042) are never rendered on this page, so
    // their stored answers must survive the delete-and-reinsert untouched.
    internalQuestionIds.length > 0
      ? c.env.DB.prepare(
          `DELETE FROM submission_answers WHERE submission_id = ?
           AND question_id NOT IN (${internalQuestionIds.map(() => '?').join(', ')})`,
        ).bind(submission.id, ...internalQuestionIds)
      : c.env.DB.prepare('DELETE FROM submission_answers WHERE submission_id = ?').bind(submission.id),
  ];
  // Stored answers keep the same display-text shape the wizard writes
  // (submit.tsx storableAnswers): the track id goes back to its name so the
  // portal detail view, organiser panel and exports read it directly.
  for (const [questionId, value] of Object.entries(storableAnswers(questions, kept))) {
    if (value === undefined) continue;
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)',
      ).bind(submission.id, questionId, JSON.stringify(value)),
    );
  }

  // Notification rows commit with the edit: no update without its notice.
  const emails = await prepareAdminUpdateEmails(c, ctx, submission, title, updatedAt);
  for (const email of emails) statements.push(...email.statements);
  await c.env.DB.batch(statements);

  await bumpEventRevision(c.env, ctx.event.id);
  for (const email of emails) await attemptImmediate(c, email);

  return c.redirect(`${base}/submissions/${id}?m=${encodeURIComponent('Submission updated.')}`);
});

// POST /:slug/submissions/:id/edit/participants/add — ABS-11: a speaker adds
// a co-author to their own submission. Same gate as the edit form itself
// (resolveEditTarget: 404 not theirs, 403 locked/closed), plus the
// participant-shaped checks the CFP wizard already enforces (submit.tsx) so
// a co-author added here is indistinguishable from one added at submit time.
portalRoutes.post('/:slug/submissions/:id/edit/participants/add', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const id = c.req.param('id');
  const editUrl = `${base}/submissions/${id}/edit`;
  const target = await resolveEditTarget(c, ctx, id);
  if (target instanceof Response) return target;
  const { submission, roleConfig } = target;
  const fail = (msg: string) => c.redirect(`${editUrl}?m=${encodeURIComponent(`!${msg}`)}`);

  const body = await c.req.parseBody();
  const firstName = typeof body.p_first === 'string' ? body.p_first.trim() : '';
  const lastName = typeof body.p_last === 'string' ? body.p_last.trim() : '';
  const email = typeof body.p_email === 'string' ? body.p_email.trim().toLowerCase() : '';
  const role = typeof body.p_role === 'string' ? body.p_role : '';

  if (!firstName || !lastName) return fail('First and last name are required.');
  if (!isValidEmailShape(email)) return fail('Enter a valid email address.');
  const allowedRoles = new Set<string>(roleConfig.map((cfg) => cfg.role));
  if (!allowedRoles.has(role)) return fail('Choose a valid role.');

  // No-write pre-checks: the cap and the duplicate lookup both fail the
  // request before anything is built, matching the "flash error, no write"
  // shape every other validation failure on this route takes.
  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM submission_participants WHERE submission_id = ?',
  )
    .bind(submission.id)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= MAX_PARTICIPANTS_PER_SUBMISSION) {
    return fail(`This submission already has the maximum of ${MAX_PARTICIPANTS_PER_SUBMISSION} participants.`);
  }
  const dup = await c.env.DB.prepare(
    `SELECT 1 FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
     WHERE sp.submission_id = ? AND lower(c.email) = lower(?)`,
  )
    .bind(submission.id, email)
    .first();
  if (dup) return fail('That person is already a participant on this submission.');

  const posRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS max_position FROM submission_participants WHERE submission_id = ?',
  )
    .bind(submission.id)
    .first<{ max_position: number }>();
  const nextPosition = (posRow?.max_position ?? -1) + 1;

  const ts = new Date().toISOString();
  // Snapshot-before-change ordering (evaluation.ts's admin add route): the
  // revision has to read the roster BEFORE this participant lands on it.
  const snapshotStmt = await snapshotParticipantsRevision(c.env.DB, {
    eventId: ctx.event.id,
    submissionId: submission.id,
    editedBy: ctx.contactId,
    editedByName: displayName(ctx.contact),
    editedAt: ts,
    source: 'portal',
  });
  const participantStmts = buildPortalParticipantStatements(c.env.DB, {
    eventId: ctx.event.id,
    submissionId: submission.id,
    email,
    firstName,
    lastName,
    role,
    position: nextPosition,
    ts,
    own: false,
  });
  await c.env.DB.batch([snapshotStmt, ...participantStmts]);
  await bumpEventRevision(c.env, ctx.event.id);
  return c.redirect(`${editUrl}?m=${encodeURIComponent('Co-author added.')}`);
});

// POST /:slug/submissions/:id/edit/participants/:pid/remove — the other half
// of ABS-11. A participant can never remove the submission's primary
// contact or their own row this way (that is what Withdraw is for), and the
// tenancy subquery keeps a foreign event's participant id from resolving
// here at all (evaluation.ts's organiser DELETE route uses the same guard).
portalRoutes.post('/:slug/submissions/:id/edit/participants/:pid/remove', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const id = c.req.param('id');
  const pid = c.req.param('pid');
  const editUrl = `${base}/submissions/${id}/edit`;
  const target = await resolveEditTarget(c, ctx, id);
  if (target instanceof Response) return target;
  const { submission } = target;

  // No-write pre-check, same shape as the add route: a row that is the
  // primary contact, the acting speaker's own membership, or simply not
  // found/foreign is refused before any statement is built, rather than
  // batching a snapshot for a delete that will not happen.
  const removable = await c.env.DB.prepare(
    `SELECT sp.id FROM submission_participants sp
     JOIN submissions s ON s.id = sp.submission_id
     WHERE sp.id = ? AND sp.submission_id = ? AND sp.is_primary_contact = 0 AND sp.contact_id != ?
       AND s.event_id = ?`,
  )
    .bind(pid, submission.id, ctx.contactId, ctx.event.id)
    .first();
  if (!removable) {
    return c.redirect(`${editUrl}?m=${encodeURIComponent('!That participant could not be removed.')}`);
  }

  const ts = new Date().toISOString();
  const snapshotStmt = await snapshotParticipantsRevision(c.env.DB, {
    eventId: ctx.event.id,
    submissionId: submission.id,
    editedBy: ctx.contactId,
    editedByName: displayName(ctx.contact),
    editedAt: ts,
    source: 'portal',
  });
  const deleteStmt = c.env.DB.prepare(
    `DELETE FROM submission_participants
     WHERE id = ? AND submission_id = ? AND is_primary_contact = 0 AND contact_id != ?
       AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
  ).bind(pid, submission.id, ctx.contactId, ctx.event.id);

  const results = await c.env.DB.batch([snapshotStmt, deleteStmt]);
  const deleteResult = results[1] as D1Result<unknown> | undefined;
  if (!deleteResult || deleteResult.meta.changes === 0) {
    return c.redirect(`${editUrl}?m=${encodeURIComponent('!That participant could not be removed.')}`);
  }
  await bumpEventRevision(c.env, ctx.event.id);
  return c.redirect(`${editUrl}?m=${encodeURIComponent('Participant removed.')}`);
});

// ---------------------------------------------------------------------------

// GET /portal/:slug/logout — same behaviour as /auth/logout.
portalRoutes.get('/:slug/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/');
});

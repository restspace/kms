// Speaker portal (docs/05): Home · Submissions · Profile · Tasks as an SSR
// multi-page app. Deliberately island-free — every interaction is a form
// POST with a redirect, plus a few lines of inline JS for confirms and the
// bio counter, so the portal stays fast and robust at 375 px (NFR budgets).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '@kms/db';
import type { Event } from '@kms/core';
import type { AppEnv } from '../env';
import { esc } from '../html';
import {
  DOCUMENT_TYPES,
  IMAGE_TYPES,
  MAX_HEADSHOT_BYTES,
  MAX_UPLOAD_BYTES,
  saveFile,
} from '../filestore';
import { sendTemplated } from '../mailer';
import { clearSessionCookie, getSession, type SessionPayload } from '../session';

export const portalRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PORTAL_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f5f6f8;color:#1f2937;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:1.25rem 1rem 4rem}
header.p-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.75rem}
header.p-head h1{font-size:1.25rem;margin:0}
.p-user{display:flex;align-items:center;gap:.6rem;font-size:.85rem;color:#6b7280}
.avatar{width:34px;height:34px;border-radius:50%;background:#2563eb;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;overflow:hidden;flex:0 0 auto}
.avatar img{width:100%;height:100%;object-fit:cover}
nav.pills{display:flex;justify-content:center;gap:.35rem;flex-wrap:wrap;margin:0 0 1.4rem}
nav.pills a{padding:.45rem 1.1rem;border-radius:999px;text-decoration:none;color:#4b5563;font-weight:600;font-size:.9rem}
nav.pills a.active{background:#2563eb;color:#fff}
nav.pills a:not(.active):hover{background:#e5e7eb}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:1.1rem 1.25rem;margin-bottom:1rem}
.card h2{font-size:1rem;margin:0 0 .75rem;display:flex;align-items:baseline;gap:.5rem}
.card h2 .count{color:#6b7280;font-weight:400;font-size:.85rem}
.card h2 a{margin-left:auto;font-size:.82rem}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
a{color:#2563eb}
.muted{color:#6b7280}.small{font-size:.85rem}
.sub-card{display:block;border:1px solid #e5e7eb;border-radius:8px;padding:.7rem .9rem;margin-bottom:.6rem;text-decoration:none;color:inherit}
.sub-card:hover{border-color:#c7d2fe}
.sub-card .t1{font-weight:600}
.sub-card .t2{color:#6b7280;font-size:.85rem}
.chip{display:inline-flex;align-items:center;gap:.35rem;padding:.1rem .6rem;border-radius:999px;font-size:.75rem;font-weight:600;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.st-accepted{background:#dcfce7;color:#15803d}.st-accepted .dot{background:#16a34a}
.st-pending{background:#fef9c3;color:#854d0e}.st-pending .dot{background:#d97706}
.st-declined{background:#fee2e2;color:#b91c1c}.st-declined .dot{background:#dc2626}
.st-draft{background:#f3f4f6;color:#4b5563}.st-draft .dot{background:#9ca3af}
.st-withdrawn{background:#e2e8f0;color:#475569}.st-withdrawn .dot{background:#64748b}
.st-accept_queue{background:#dcfce7;color:#15803d}.st-accept_queue .dot{background:#4ade80}
.st-decline_queue{background:#fef3c7;color:#b45309}.st-decline_queue .dot{background:#f59e0b}
.task{border:1px solid #e5e7eb;border-radius:8px;padding:.8rem .9rem;margin-bottom:.6rem}
.task .t-head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.task .t-title{font-weight:600;flex:1 1 auto}
.task .due{font-size:.82rem;color:#6b7280}
.task .due.overdue{color:#dc2626;font-weight:700}
.badge-overdue{background:#fee2e2;color:#b91c1c;border-radius:4px;padding:.05rem .4rem;font-size:.72rem;font-weight:700}
.t-status{font-size:.75rem;font-weight:600;border-radius:999px;padding:.1rem .6rem}
.t-status.not_started{background:#f3f4f6;color:#4b5563}
.t-status.in_progress{background:#fef9c3;color:#854d0e}
.t-status.complete{background:#dcfce7;color:#15803d}
.t-body{margin-top:.6rem;border-top:1px solid #f3f4f6;padding-top:.6rem}
label{display:block;font-weight:600;font-size:.85rem;margin:.7rem 0 .25rem}
input[type=text],input[type=email],input[type=url],input[type=tel],select,textarea{width:100%;padding:.5rem .65rem;border:1px solid #d1d5db;border-radius:6px;font:inherit;background:#fff}
textarea{resize:vertical}
button,.btn{display:inline-block;border:0;border-radius:6px;background:#2563eb;color:#fff;font:inherit;font-weight:600;padding:.5rem 1.1rem;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:#1d4ed8}
button.secondary,.btn.secondary{background:#fff;color:#1f2937;border:1px solid #d1d5db}
button.danger{background:#fff;color:#dc2626;border:1px solid #fecaca}
.flash{border-radius:8px;padding:.6rem .9rem;margin-bottom:1rem;font-size:.9rem}
.flash.ok{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
.flash.err{background:#fee2e2;color:#b91c1c;border:1px solid #fecaca}
.banner{background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:.5rem .8rem;font-size:.88rem;margin-bottom:1rem}
dl.detail{display:grid;grid-template-columns:150px 1fr;gap:.4rem .8rem;font-size:.92rem;margin:0}
dl.detail dt{color:#6b7280}
dl.detail dd{margin:0;overflow-wrap:anywhere}
.counter{font-weight:400;color:#6b7280;font-size:.78rem;margin-left:.4rem}
.headshot-preview{width:96px;height:96px;border-radius:50%;object-fit:cover;border:1px solid #e5e7eb;display:block;margin-bottom:.5rem}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82rem;color:#6b7280}
`;

type PortalSection = 'home' | 'submissions' | 'profile' | 'tasks';

interface PortalCtx {
  event: Event;
  session: SessionPayload;
  contact: ContactRow;
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
${flashHtml}
${body}
</div>
</body>
</html>`;
}

function statusChipHtml(status: string): string {
  const label = status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `<span class="chip st-${esc(status)}"><span class="dot"></span>${esc(label)}</span>`;
}

const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// ---------------------------------------------------------------------------
// Context middleware: event + session + contact, or the login page
// ---------------------------------------------------------------------------

function loginPage(event: Event): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — ${esc(event.name)}</title><style>${PORTAL_CSS}</style></head><body><div class="wrap" style="max-width:480px">
<div class="card"><h2>${esc(event.name)}</h2>
<p>Enter your email address and we will send you a sign-in link — no password needed.</p>
<form method="post" action="/auth/request">
<label for="email">Email address</label>
<input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
<input type="hidden" name="event_slug" value="${esc(event.slug)}">
<p><button type="submit">Email me a sign-in link</button></p>
</form></div></div></body></html>`;
}

async function loadPortalCtx(c: Context<AppEnv>): Promise<PortalCtx | Response> {
  const slug = c.req.param('slug') ?? '';
  const db = createDb(c.env.DB);
  const event = await db.events.getBySlug(slug);
  if (!event) return c.html('<h1>Event not found</h1>', 404);
  const session = await getSession(c);
  if (!session || session.eventId !== event.id) return c.html(loginPage(event), 401);
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?')
    .bind(session.contactId)
    .first<ContactRow>();
  if (!contact) return c.html(loginPage(event), 401);
  return { event, session, contact };
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

async function loadAssignments(c: Context<AppEnv>, contactId: string): Promise<TaskAssignmentRow[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT ta.id AS assignment_id, ta.status, ta.completed_at, ta.submission_id,
            s.code AS submission_code, s.title AS submission_title,
            t.id AS task_id, t.title, t.description, t.action_type,
            t.portal_form_id, t.file_request_id, t.due_at, t.required
     FROM task_assignments ta
     JOIN tasks t ON t.id = ta.task_id
     LEFT JOIN submissions s ON s.id = ta.submission_id
     WHERE ta.contact_id = ?
     ORDER BY CASE ta.status WHEN 'complete' THEN 1 ELSE 0 END, t.due_at`,
  )
    .bind(contactId)
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
    db.submissions.listByContact(ctx.event.id, ctx.session.contactId),
    loadAssignments(c, ctx.session.contactId),
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
          overdueCount > 0 ? ` — <strong style="color:#dc2626">${overdueCount} overdue</strong>` : ''
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
${!ctx.contact.biography || !ctx.contact.headshot_asset_id ? '<p class="small" style="color:#b45309">Your bio or headshot is missing — organisers use both in the programme.</p>' : ''}
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
    .bind(ctx.event.id, ctx.session.contactId, ctx.session.contactId)
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

  const submission = await c.env.DB.prepare(
    `SELECT s.*, t.name AS track_name FROM submissions s
     LEFT JOIN tracks t ON t.id = s.track_id
     WHERE s.id = ? AND s.event_id = ? AND (s.submitter_contact_id = ?
       OR EXISTS (SELECT 1 FROM submission_participants sp WHERE sp.submission_id = s.id AND sp.contact_id = ?))`,
  )
    .bind(id, ctx.event.id, ctx.session.contactId, ctx.session.contactId)
    .first<Record<string, unknown>>();
  if (!submission) return c.redirect(`${base}/submissions`);

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
      if (Array.isArray(v)) return v.join(', ');
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      return String(v).replace(/<[^>]*>/g, '') || '—';
    } catch {
      return json;
    }
  };

  const canWithdraw =
    submission.status !== 'withdrawn' && submission.status !== 'declined' &&
    submission.submitter_contact_id === ctx.session.contactId;

  return c.html(
    portalPage(
      ctx,
      'submissions',
      `<div class="card">
<h2><span class="code">${esc(String(submission.code))}</span> ${esc(String(submission.title))} ${statusChipHtml(String(submission.status))}</h2>
<dl class="detail">
${submission.format ? `<dt>Format</dt><dd>${esc(String(submission.format))}</dd>` : ''}
${submission.track_name ? `<dt>Track</dt><dd>${esc(String(submission.track_name))}</dd>` : ''}
${answers.map((a) => `<dt>${esc(a.label)}</dt><dd>${esc(answerValue(a.value_json))}</dd>`).join('')}
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
<p class="small muted" style="margin-top:.8rem">Need to change something? Contact the organisers — editing reopens with a later milestone.</p>`,
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
    .bind(new Date().toISOString(), id, ctx.event.id, ctx.session.contactId)
    .run();
  return c.redirect(`${base}/submissions/${id}?m=${encodeURIComponent('Submission withdrawn.')}`);
});

// ---------------------------------------------------------------------------
// Profile (docs/05 §5)
// ---------------------------------------------------------------------------

const PRONOUN_OPTIONS = ['', 'they/them', 'she/her', 'he/him', 'prefer not to say', 'self-describe'];

portalRoutes.get('/:slug/profile', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${esc(ctx.event.slug)}`;
  const contact = ctx.contact;
  let links: Record<string, string> = {};
  try {
    links = contact.links ? (JSON.parse(contact.links) as Record<string, string>) : {};
  } catch { /* empty */ }

  const field = (name: string, label: string, value: string | null, type = 'text', required = false) =>
    `<label for="f-${name}">${label}</label><input type="${type}" id="f-${name}" name="${name}" value="${esc(value ?? '')}"${required ? ' required' : ''}>`;

  return c.html(
    portalPage(
      ctx,
      'profile',
      `<form method="post" action="${base}/profile" enctype="multipart/form-data">
<div class="grid2">
<div class="card"><h2>General</h2>
<label for="f-biography">Biography <span class="counter" id="bio-count"></span></label>
<textarea id="f-biography" name="biography" rows="7" maxlength="5000">${esc(contact.biography ?? '')}</textarea>
${field('salutation', 'Salutation', contact.salutation)}
${field('first_name', 'First Name *', contact.first_name, 'text', true)}
${field('last_name', 'Last Name *', contact.last_name, 'text', true)}
${field('honorific', 'Honorific', contact.honorific)}
<label for="f-pronouns">Pronouns</label>
<select id="f-pronouns" name="pronouns">${PRONOUN_OPTIONS.map(
        (p) => `<option value="${esc(p)}"${(contact.pronouns ?? '') === p ? ' selected' : ''}>${esc(p || '—')}</option>`,
      ).join('')}</select>
${field('company', 'Company', contact.company)}
${field('job_title', 'Job title', contact.job_title)}
<label for="f-headshot">Headshot <span class="muted small">(square works best, max 5 MB)</span></label>
${contact.headshot_asset_id ? `<img class="headshot-preview" src="/files/${esc(contact.headshot_asset_id)}" alt="Current headshot">` : ''}
<input type="file" id="f-headshot" name="headshot" accept="image/*">
</div>
<div class="card"><h2>My Links</h2>
${field('link_linkedin', 'LinkedIn URL', links.linkedin ?? null, 'url')}
${field('link_twitter', 'X (Twitter) URL', links.twitter ?? null, 'url')}
${field('link_facebook', 'Facebook URL', links.facebook ?? null, 'url')}
${field('link_website', 'Website', links.website ?? null, 'url')}
<p style="margin-top:1.2rem"><button type="submit">Save profile</button></p>
</div>
</div>
</form>
<script>
const bio=document.getElementById('f-biography'),count=document.getElementById('bio-count');
const upd=()=>{count.textContent=bio.value.length.toLocaleString()+' / 5,000 characters'};
bio.addEventListener('input',upd);upd();
</script>`,
      flashOf(c),
    ),
  );
});

portalRoutes.post('/:slug/profile', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const body = await c.req.parseBody();

  const text = (name: string): string | null => {
    const v = body[name];
    return typeof v === 'string' ? v.trim() || null : null;
  };
  const first = text('first_name');
  const last = text('last_name');
  if (!first || !last) {
    return c.redirect(`${base}/profile?m=${encodeURIComponent('!First and last name are required.')}`);
  }
  for (const key of ['link_linkedin', 'link_twitter', 'link_facebook', 'link_website']) {
    const v = text(key);
    if (v && !/^https?:\/\//i.test(v)) {
      return c.redirect(`${base}/profile?m=${encodeURIComponent('!Links must start with http:// or https://')}`);
    }
  }

  let headshotId = ctx.contact.headshot_asset_id;
  const upload = body.headshot;
  if (upload instanceof File && upload.size > 0) {
    const saved = await saveFile(c.env, {
      eventId: ctx.event.id,
      uploadedByContactId: ctx.session.contactId,
      file: upload,
      maxBytes: MAX_HEADSHOT_BYTES,
      allowedTypes: IMAGE_TYPES,
    });
    if ('error' in saved) {
      return c.redirect(`${base}/profile?m=${encodeURIComponent(`!${saved.error}`)}`);
    }
    headshotId = saved.id;
  }

  const links = JSON.stringify({
    linkedin: text('link_linkedin') ?? '',
    twitter: text('link_twitter') ?? '',
    facebook: text('link_facebook') ?? '',
    website: text('link_website') ?? '',
  });
  await c.env.DB.prepare(
    `UPDATE contacts SET biography = ?, salutation = ?, first_name = ?, last_name = ?, honorific = ?,
       pronouns = ?, company = ?, job_title = ?, headshot_asset_id = ?, links = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      text('biography'),
      text('salutation'),
      first,
      last,
      text('honorific'),
      text('pronouns'),
      text('company'),
      text('job_title'),
      headshotId,
      links,
      new Date().toISOString(),
      ctx.session.contactId,
    )
    .run();
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

function taskActionHtml(base: string, t: TaskAssignmentRow, portalForm: { title: string | null; questions: PortalFormQuestion[] } | null): string {
  if (t.status === 'complete') {
    return `<p class="small muted">Completed ${esc(fmtDate(t.completed_at))}.</p>`;
  }
  const action = `${base}/tasks/${esc(t.assignment_id)}/complete`;
  switch (t.action_type) {
    case 'acknowledge':
      return `<form method="post" action="${action}">
<label class="small" style="font-weight:400"><input type="checkbox" name="agree" value="1" required> I have read and agree</label>
<p><button type="submit">Confirm</button></p></form>`;
    case 'external_link': {
      const url = t.description?.match(/https?:\/\/\S+/)?.[0];
      return `<form method="post" action="${action}">
${url ? `<p><a class="btn secondary" href="${esc(url)}" target="_blank" rel="noopener">Open link</a></p>` : ''}
<p><button type="submit">Mark as done</button></p></form>`;
    }
    case 'file_upload':
      return `<form method="post" action="${action}" enctype="multipart/form-data">
<label>File <span class="muted small">(PDF, slides, docs or images — max 20 MB)</span></label>
<input type="file" name="upload" required>
<p><button type="submit">Upload &amp; complete</button></p></form>`;
    case 'portal_form': {
      if (!portalForm || portalForm.questions.length === 0) {
        return '<p class="small muted">This form is not available yet.</p>';
      }
      const fields = portalForm.questions
        .map((q) => {
          const id = `pf-${esc(q.id)}`;
          const req = q.required ? ' required' : '';
          const star = q.required ? ' *' : '';
          if (q.type === 'dropdown' && q.options) {
            return `<label for="${id}">${esc(q.label)}${star}</label>
<select id="${id}" name="q_${esc(q.id)}"${req}><option value="">Select…</option>${q.options
              .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
              .join('')}</select>`;
          }
          if (q.type === 'checkbox') {
            return `<label class="small" style="font-weight:400"><input type="checkbox" name="q_${esc(q.id)}" value="yes"${req}> ${esc(q.label)}${star}</label>`;
          }
          if (q.type === 'textarea') {
            return `<label for="${id}">${esc(q.label)}${star}</label><textarea id="${id}" name="q_${esc(q.id)}" rows="3"${req}></textarea>`;
          }
          return `<label for="${id}">${esc(q.label)}${star}</label><input type="${q.type === 'date' ? 'date' : 'text'}" id="${id}" name="q_${esc(q.id)}"${req}>`;
        })
        .join('');
      return `<form method="post" action="${action}">${fields}<p><button type="submit">Submit &amp; complete</button></p></form>`;
    }
  }
}

portalRoutes.get('/:slug/tasks', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${esc(ctx.event.slug)}`;
  const assignments = await loadAssignments(c, ctx.session.contactId);

  // portal_form definitions for any form-backed tasks on the page
  const formIds = [...new Set(assignments.map((t) => t.portal_form_id).filter((v): v is string => v !== null))];
  const forms = new Map<string, { title: string | null; questions: PortalFormQuestion[] }>();
  for (const formId of formIds) {
    const row = await c.env.DB.prepare('SELECT title, questions FROM portal_forms WHERE id = ?')
      .bind(formId)
      .first<{ title: string | null; questions: string | null }>();
    if (row) forms.set(formId, { title: row.title, questions: parsePortalFormQuestions(row.questions) });
  }

  const renderTask = (t: TaskAssignmentRow): string => `<div class="task" id="a-${esc(t.assignment_id)}">
<div class="t-head">
<span class="t-title">${esc(t.title)}${t.required === 1 ? ' <span class="muted small">(required)</span>' : ''}</span>
${t.due_at ? `<span class="due${isOverdue(t) ? ' overdue' : ''}">Due ${esc(fmtDate(t.due_at))}</span>` : ''}
${isOverdue(t) ? '<span class="badge-overdue">Overdue</span>' : ''}
<span class="t-status ${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span>
</div>
${t.description ? `<div class="small muted" style="margin-top:.3rem">${esc(t.description.replace(/<[^>]*>/g, ''))}</div>` : ''}
${t.submission_code ? `<div class="small muted">For <span class="code">${esc(t.submission_code)}</span> ${esc(t.submission_title ?? '')}</div>` : ''}
<div class="t-body">${taskActionHtml(base, t, t.portal_form_id ? forms.get(t.portal_form_id) ?? null : null)}</div>
</div>`;

  const submissionTasks = assignments.filter((t) => t.submission_id !== null);
  const myTasks = assignments.filter((t) => t.submission_id === null);

  return c.html(
    portalPage(
      ctx,
      'tasks',
      `<div class="card"><h2>Submission Tasks <span class="count">${submissionTasks.length}</span></h2>
${submissionTasks.length === 0 ? '<p class="muted">No submission tasks found.</p>' : submissionTasks.map(renderTask).join('')}
</div>
<div class="card"><h2>My Tasks <span class="count">${myTasks.length}</span></h2>
${myTasks.length === 0 ? '<p class="muted">No tasks found.</p>' : myTasks.map(renderTask).join('')}
</div>`,
      flashOf(c),
    ),
  );
});

portalRoutes.post('/:slug/tasks/:assignmentId/complete', async (c) => {
  const ctx = await loadPortalCtx(c);
  if (ctx instanceof Response) return ctx;
  const base = `/portal/${ctx.event.slug}`;
  const assignmentId = c.req.param('assignmentId');
  const back = (msg: string) => c.redirect(`${base}/tasks?m=${encodeURIComponent(msg)}#a-${assignmentId}`);

  const row = await c.env.DB.prepare(
    `SELECT ta.id AS assignment_id, ta.status, ta.completed_at, ta.submission_id,
            NULL AS submission_code, NULL AS submission_title,
            t.id AS task_id, t.title, t.description, t.action_type,
            t.portal_form_id, t.file_request_id, t.due_at, t.required
     FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
     WHERE ta.id = ? AND ta.contact_id = ? AND t.event_id = ?`,
  )
    .bind(assignmentId, ctx.session.contactId, ctx.event.id)
    .first<TaskAssignmentRow>();
  if (!row) return back('!Task not found.');
  if (row.status === 'complete') return back('Task already complete.');

  const ts = new Date().toISOString();
  let responseId: string | null = null;

  if (row.action_type === 'file_upload') {
    const body = await c.req.parseBody();
    const upload = body.upload;
    if (!(upload instanceof File) || upload.size === 0) return back('!Choose a file to upload.');
    const saved = await saveFile(c.env, {
      eventId: ctx.event.id,
      uploadedByContactId: ctx.session.contactId,
      file: upload,
      maxBytes: MAX_UPLOAD_BYTES,
      allowedTypes: DOCUMENT_TYPES,
    });
    if ('error' in saved) return back(`!${saved.error}`);
    responseId = saved.id;
    if (row.file_request_id) {
      await c.env.DB.prepare(
        `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), row.file_request_id, ctx.session.contactId, row.submission_id, saved.id, ts)
        .run();
    }
  } else if (row.action_type === 'acknowledge') {
    const body = await c.req.parseBody();
    if (body.agree !== '1') return back('!Please tick the confirmation first.');
  } else if (row.action_type === 'portal_form') {
    if (!row.portal_form_id) return back('!This form is not available.');
    const form = await c.env.DB.prepare('SELECT * FROM portal_forms WHERE id = ?')
      .bind(row.portal_form_id)
      .first<{ id: string; name: string; questions: string | null; send_confirmation_email: number }>();
    if (!form) return back('!This form is not available.');
    const questions = parsePortalFormQuestions(form.questions);
    const body = await c.req.parseBody();
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const v = body[`q_${q.id}`];
      const value = typeof v === 'string' ? v.trim() : '';
      if (q.required && value === '') return back(`!${q.label} is required.`);
      if (value !== '') answers[q.id] = value;
    }
    responseId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO portal_form_responses (id, portal_form_id, contact_id, submission_id, answers, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(responseId, form.id, ctx.session.contactId, row.submission_id, JSON.stringify(answers), ts)
      .run();
    if (form.send_confirmation_email === 1) {
      await sendTemplated(c, {
        templateKey: 'portal_form_confirmation',
        eventId: ctx.event.id,
        contactId: ctx.session.contactId,
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
  // external_link needs no payload — the button press is the confirmation.

  await c.env.DB.prepare(
    `UPDATE task_assignments SET status = 'complete', completed_at = ?, response_id = ? WHERE id = ?`,
  )
    .bind(ts, responseId, assignmentId)
    .run();
  return back('Task completed — thank you!');
});

// ---------------------------------------------------------------------------

// GET /portal/:slug/logout — same behaviour as /auth/logout.
portalRoutes.get('/:slug/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/');
});

// Template rendering (docs/08 §1–2): merge variables over code-default
// templates, with per-event DB rows overriding subject/body and a theme
// wrapping every message in the same 600px table layout. Unknown variables
// render as empty strings by design.

export interface TemplateOverride {
  subject: string | null;
  body_richtext: string | null;
  enabled: number;
}

export interface ThemeConfig {
  name?: string;
  primary_color?: string | null;
  background_color?: string | null;
  font?: string | null;
  /** Heading face. A *stack*, never a webfont — see DEFAULT_THEME. */
  display_font?: string | null;
  header_html?: string | null;
  footer_html?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Flatten {event: {name: 'x'}} into {'event.name': 'x'} for lookup. */
function flatten(context: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(context)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flatten(value as Record<string, unknown>, path)) out.set(k, v);
    } else if (value !== undefined && value !== null) {
      out.set(path, String(value));
    }
  }
  return out;
}

/**
 * Replace {{var.path}} with context values; unknown variables become ''.
 * Triple-brace {{{var.path}}} interpolates *raw*, bypassing the transform —
 * for system-prerendered HTML blocks (decision_summary's {{decisions_block}}
 * family) that would otherwise be escaped into visible markup. Context values
 * for raw slots are always built server-side with escapeHtml applied to any
 * user-entered text; never point a raw slot at unescaped user input.
 */
export function mergeVariables(
  template: string,
  context: Record<string, unknown>,
  transform: (value: string) => string = (value) => value,
): string {
  const vars = flatten(context);
  return template
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, path: string) => vars.get(path) ?? '')
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => transform(vars.get(path) ?? ''));
}

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Crude but dependable HTML→text for the plain-text alternative part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]*>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
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

// ---------------------------------------------------------------------------
// Default templates (docs/08 §1). Bodies are HTML fragments; the theme
// wrapper supplies the document. DB rows override subject/body per event.
// ---------------------------------------------------------------------------

interface DefaultTemplate {
  subject: string;
  body: string;
}

export const DEFAULT_TEMPLATES: Record<string, DefaultTemplate> = {
  magic_link: {
    subject: 'Your sign-in link for {{event.name}}',
    body: `<p>Sign in to <strong>{{event.name}}</strong>:</p>
<p><a href="{{magic_link}}" class="btn">Sign in</a></p>
<p>This link expires in 15 minutes and can only be used once. If you did not request it, you can ignore this email.</p>`,
  },
  submission_confirmation: {
    // {{portal_url}} carries a purpose-bound single-use magic link minted in
    // the submission transaction (sweep item P0-3): opening it in a fresh
    // browser authenticates the submitter into their portal.
    subject: 'Submission received: {{submission.title}} ({{submission.code}})',
    body: `<p>Thanks for your proposal to <strong>{{event.name}}</strong>!</p>
<p>&ldquo;{{submission.title}}&rdquo; was received as <strong>{{submission.code}}</strong> and is now pending review.</p>
<p><a href="{{portal_url}}" class="btn">Open your speaker portal</a></p>
<p>Use your portal to track this submission, complete tasks and keep your speaker profile up to date.</p>`,
  },
  submission_received_admin: {
    subject: 'New submission: {{submission.title}} ({{submission.code}}) — {{event.name}}',
    body: `<p>A new submission arrived for <strong>{{event.name}}</strong>:</p>
<p><strong>{{submission.title}}</strong> ({{submission.code}}){{submission.track_line}}</p>
<p>Submitted by {{submitter.name}} &lt;{{submitter.email}}&gt;.</p>
<p><a href="{{admin_url}}" class="btn">Review it in the workspace</a></p>`,
  },
  submission_updated_admin: {
    subject: 'Submission updated: {{submission.title}} ({{submission.code}}) — {{event.name}}',
    body: `<p>A submission to <strong>{{event.name}}</strong> was updated:</p>
<p><strong>{{submission.title}}</strong> ({{submission.code}})</p>
<p>Updated by {{submitter.name}} &lt;{{submitter.email}}&gt;.</p>
<p><a href="{{admin_url}}" class="btn">See what changed</a></p>`,
  },
  submission_updated: {
    subject: 'Submission updated: {{submission.title}} ({{submission.code}})',
    body: `<p>Your changes to <strong>{{submission.title}}</strong> ({{submission.code}}) were saved.</p>
<p><a href="{{portal_url}}">View it in your portal</a></p>`,
  },
  // {{reviewer_feedback}} renders shared reviewer comments when the organiser
  // opts in per send (Swyx-1 bonus); unknown/absent variables render as ''.
  // {{{approval_ask}}} is the optional employer-approval ask (workplan 13 W3):
  // prerendered system HTML supplied by the bulk-jobs expander when the
  // organiser enables it for a batch, '' otherwise.
  decision_accepted: {
    subject: 'Congratulations — {{submission.title}} was accepted for {{event.name}}',
    body: `<p>Great news, {{speaker.first_name}}!</p>
<p><strong>{{submission.title}}</strong> ({{submission.code}}) has been <strong>accepted</strong> for {{event.name}}.</p>
<p style="white-space:pre-line;">{{reviewer_feedback}}</p>
{{{approval_ask}}}
<p>Your speaker portal lists everything we need from you next — including any onboarding tasks.</p>
<p><a href="{{portal_url}}" class="btn">Open your speaker portal</a></p>`,
  },
  decision_declined: {
    subject: 'Your {{event.name}} submission: {{submission.title}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>Thank you for submitting <strong>{{submission.title}}</strong> ({{submission.code}}) to {{event.name}}. After careful review we are unable to include it in this year's programme.</p>
<p style="white-space:pre-line;">{{reviewer_feedback}}</p>
<p>We would love to see you submit again next time.</p>`,
  },
  // Workplan 10: one email per speaker per decision batch when they have ≥2
  // decisions queued (single-decision speakers keep the two templates above —
  // D6). The {{{…}}} blocks are prerendered by the bulk-jobs expander:
  // decisions_block (accepts first, feedback nested), pending_note (other
  // submissions still under review, when enabled), followup_note (earlier
  // batches already notified), closing_block (portal button + onboarding line
  // when any accept, softer sign-off when declines-only).
  decision_summary: {
    subject: 'Your {{event.name}} submissions — decisions',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>We have decisions on your submissions to <strong>{{event.name}}</strong>:</p>
{{{decisions_block}}}
{{{pending_note}}}
{{{followup_note}}}
{{{closing_block}}}`,
  },
  task_assigned: {
    subject: 'New task for {{event.name}}: {{task.title}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>You have a new task for <strong>{{event.name}}</strong>:</p>
<p><strong>{{task.title}}</strong>{{task.due_line}}</p>
<p><a href="{{task.url}}" class="btn">Open the task</a></p>`,
  },
  task_reminder: {
    subject: 'Reminder: {{task.title}} — {{event.name}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>A quick reminder about <strong>{{task.title}}</strong> for {{event.name}}{{task.due_line}}.</p>
<p><a href="{{task.url}}" class="btn">Complete it in your portal</a></p>`,
  },
  draft_reminder: {
    subject: 'Your draft for {{event.name}} — submissions close {{form.close_at}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>You have an unsubmitted draft for <strong>{{form.name}}</strong>. Submissions close <strong>{{form.close_at}}</strong> — after that the form locks.</p>
<p><a href="{{submission_url}}" class="btn">Finish your submission</a></p>`,
  },
  schedule_confirmed: {
    subject: 'You are scheduled: {{submission.title}} — {{event.name}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p><strong>{{submission.title}}</strong> is scheduled:</p>
<p><strong>{{session.starts_at}}</strong><br>{{session.room}}, {{event.location}}</p>
<p>The attached calendar invite adds it to your calendar. Or use:
<a href="{{calendar.google_url}}">Google Calendar</a> · <a href="{{calendar.outlook_url}}">Outlook</a></p>`,
  },
  schedule_changed: {
    subject: 'Schedule change: {{submission.title}} — {{event.name}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>Your session <strong>{{submission.title}}</strong> has moved:</p>
<p><strong>{{session.starts_at}}</strong><br>{{session.room}}, {{event.location}}</p>
<p>The attached invite updates the existing entry in your calendar. Or use:
<a href="{{calendar.google_url}}">Google Calendar</a> · <a href="{{calendar.outlook_url}}">Outlook</a></p>`,
  },
  schedule_cancelled: {
    subject: 'Session removed from the schedule: {{submission.title}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p><strong>{{submission.title}}</strong> is no longer scheduled at its previous time. The attached update removes it from your calendar.</p>`,
  },
  portal_form_confirmation: {
    subject: 'Response received — {{form.name}}',
    body: `<p>Thanks, {{speaker.first_name}} — your response to <strong>{{form.name}}</strong> was recorded.</p>`,
  },
};

/**
 * Sympathetic to the app theme, not identical to it (workplan §4). Email
 * clients do not reliably support webfonts, so the heading face is a *stack*
 * that lands on something serif everywhere rather than the app's Source
 * Serif 4; and every value here is a literal 6-digit hex on an opaque
 * background, because Outlook drops custom properties, most modern CSS colour
 * functions, and border-radius. Losing the radius is harmless — the editorial
 * theme is near-square anyway.
 */
const DEFAULT_THEME: Required<
  Pick<ThemeConfig, 'primary_color' | 'background_color' | 'font' | 'display_font'>
> = {
  primary_color: '#2c4a73',
  background_color: '#faf7f0',
  font: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  display_font: "Georgia, 'Times New Roman', Times, serif",
};

/** Wrap a rendered body in the themed 600px table layout (docs/08 §2). */
export function applyTheme(
  bodyHtml: string,
  subject: string,
  theme: ThemeConfig | null,
  eventName: string,
): string {
  const primary = theme?.primary_color ?? DEFAULT_THEME.primary_color;
  const background = theme?.background_color ?? DEFAULT_THEME.background_color;
  const font = theme?.font ?? DEFAULT_THEME.font;
  const displayFont = theme?.display_font ?? DEFAULT_THEME.display_font;
  const header =
    theme?.header_html ??
    `<h2 style="margin:0;font-family:${displayFont};font-size:20px;font-weight:normal;color:#ffffff;">${escapeHtml(eventName)}</h2>`;
  const footer =
    theme?.footer_html ??
    `<p style="margin:0;color:#6b6259;font-size:12px;">You are receiving this because of your participation in ${escapeHtml(eventName)}.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${background};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fffdf8;border-radius:2px;overflow:hidden;font-family:${font};font-size:15px;line-height:1.6;color:#1c1917;">
<tr><td style="background:${primary};padding:18px 28px;">${header}</td></tr>
<tr><td style="padding:26px 28px;">
<style>a.btn{display:inline-block;background:${primary};color:#ffffff !important;text-decoration:none;padding:10px 22px;border-radius:2px;font-weight:600;}</style>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e3ddce;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * Render a template: DB override wins when present and non-empty, otherwise
 * the code default; merge variables in subject and body; theme the HTML and
 * derive the plain-text alternative.
 */
export function renderTemplate(
  templateKey: string,
  override: TemplateOverride | null,
  theme: ThemeConfig | null,
  context: Record<string, unknown>,
): RenderedEmail | null {
  const fallback = DEFAULT_TEMPLATES[templateKey];
  if (override && override.enabled === 0) return null; // explicitly disabled
  const subjectSource = override?.subject || fallback?.subject;
  const bodySource = override?.body_richtext || fallback?.body;
  if (!subjectSource || !bodySource) return null;

  const eventName =
    typeof (context.event as Record<string, unknown> | undefined)?.name === 'string'
      ? ((context.event as Record<string, unknown>).name as string)
      : '';
  // Subjects are header-like values, so collapse CR/LF. HTML variables are
  // escaped by default: public submission titles and speaker names must never
  // become markup just because a template interpolates them.
  const subject = mergeVariables(subjectSource, context).replace(/[\r\n]+/g, ' ');
  const bodyHtml = mergeVariables(bodySource, context, escapeHtml);
  return {
    subject,
    html: applyTheme(bodyHtml, subject, theme, eventName),
    text: htmlToText(bodyHtml),
  };
}

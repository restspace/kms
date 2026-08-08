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

/** Replace {{var.path}} with context values; unknown variables become ''. */
export function mergeVariables(template: string, context: Record<string, unknown>): string {
  const vars = flatten(context);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => vars.get(path) ?? '');
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    subject: 'Submission received: {{submission.title}} ({{submission.code}})',
    body: `<p>Thanks for your proposal to <strong>{{event.name}}</strong>!</p>
<p>&ldquo;{{submission.title}}&rdquo; was received as <strong>{{submission.code}}</strong> and is now pending review.</p>
<p><a href="{{portal_url}}" class="btn">Open your speaker portal</a></p>
<p>Use your portal to track this submission, complete tasks and keep your speaker profile up to date.</p>`,
  },
  submission_updated: {
    subject: 'Submission updated: {{submission.title}} ({{submission.code}})',
    body: `<p>Your changes to <strong>{{submission.title}}</strong> ({{submission.code}}) were saved.</p>
<p><a href="{{portal_url}}">View it in your portal</a></p>`,
  },
  decision_accepted: {
    subject: 'Congratulations — {{submission.title}} was accepted for {{event.name}}',
    body: `<p>Great news, {{speaker.first_name}}!</p>
<p><strong>{{submission.title}}</strong> ({{submission.code}}) has been <strong>accepted</strong> for {{event.name}}.</p>
<p>Your speaker portal lists everything we need from you next — including any onboarding tasks.</p>
<p><a href="{{portal_url}}" class="btn">Open your speaker portal</a></p>`,
  },
  decision_declined: {
    subject: 'Your {{event.name}} submission: {{submission.title}}',
    body: `<p>Hi {{speaker.first_name}},</p>
<p>Thank you for submitting <strong>{{submission.title}}</strong> ({{submission.code}}) to {{event.name}}. After careful review we are unable to include it in this year's programme.</p>
<p>We would love to see you submit again next time.</p>`,
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

const DEFAULT_THEME: Required<Pick<ThemeConfig, 'primary_color' | 'background_color' | 'font'>> = {
  primary_color: '#2563eb',
  background_color: '#f5f6f8',
  font: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
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
  const header =
    theme?.header_html ??
    `<h2 style="margin:0;font-size:18px;color:#ffffff;">${escapeHtml(eventName)}</h2>`;
  const footer =
    theme?.footer_html ??
    `<p style="margin:0;color:#6b7280;font-size:12px;">You are receiving this because of your participation in ${escapeHtml(eventName)}.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${background};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:${font};font-size:15px;line-height:1.6;color:#1f2937;">
<tr><td style="background:${primary};padding:18px 28px;">${header}</td></tr>
<tr><td style="padding:26px 28px;">
<style>a.btn{display:inline-block;background:${primary};color:#ffffff !important;text-decoration:none;padding:10px 22px;border-radius:6px;font-weight:600;}</style>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">${footer}</td></tr>
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
  const subject = mergeVariables(subjectSource, context);
  const bodyHtml = mergeVariables(bodySource, context);
  return {
    subject,
    html: applyTheme(bodyHtml, subject, theme, eventName),
    text: htmlToText(bodyHtml),
  };
}

// Email provider seam (docs/03 §1, docs/08 §3/§5). Resend carries ordinary
// transactional mail. Calendar invites need the text/calendar alternative
// MIME part preserved — the M0 spike proved Resend strips it (resend-node
// #198), so invite mail prefers SendGrid when a key is present and falls
// back to a Resend .ics attachment (renders natively in Gmail, not Outlook).

export * from './render';
export * from './ics';

export interface IcsPayload {
  /** full VCALENDAR text */
  content: string;
  method: 'REQUEST' | 'CANCEL';
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** when present the message is a calendar invite (docs/08 §5) */
  ics?: IcsPayload;
  /**
   * message_log idempotency key (sweep item P2-20). Declared here — not only
   * on mailer.ts's OutboxEmailPayload — so providers can read it off the
   * `OutgoingEmail` they're handed without a cast; `OutboxEmailPayload`
   * narrows it to required. Passed to providers that support server-side
   * idempotency so a crash after acceptance but before the local
   * message_log/outbox update is recorded can't cause a double-send.
   */
  log_key?: string;
}

export interface EmailProvider {
  send(mail: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
};

export function createResendProvider(apiKey: string, from: string): EmailProvider {
  return {
    async send(mail) {
      const body: Record<string, unknown> = {
        from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      };
      if (mail.ics) {
        // Attachment-only: Gmail renders it natively, Outlook shows a file.
        body.attachments = [
          {
            filename: 'invite.ics',
            content: b64(mail.ics.content),
            content_type: `text/calendar; method=${mail.ics.method}; charset=UTF-8`,
          },
        ];
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Resend dedupes retried sends within a rolling window when the
          // same key is replayed (sweep item P2-20).
          ...(mail.log_key ? { 'Idempotency-Key': mail.log_key } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
      const out = (await res.json()) as { id: string };
      return { providerMessageId: out.id };
    },
  };
}

/**
 * SendGrid v3 — used for invite mail because its content array carries the
 * text/calendar part as a true multipart/alternative sibling (the shape
 * Outlook requires), plus the .ics attachment for everything else.
 */
export function createSendGridProvider(apiKey: string, from: string): EmailProvider {
  const fromMatch = from.match(/^(.*)<(.+)>$/);
  const fromEmail = fromMatch ? fromMatch[2]!.trim() : from;
  const fromName = fromMatch ? fromMatch[1]!.trim().replace(/^"|"$/g, '') : undefined;
  return {
    async send(mail) {
      const content: Array<{ type: string; value: string }> = [
        { type: 'text/plain', value: mail.text },
        { type: 'text/html', value: mail.html },
      ];
      const body: Record<string, unknown> = {
        personalizations: [{ to: [{ email: mail.to }] }],
        from: { email: fromEmail, ...(fromName ? { name: fromName } : {}) },
        subject: mail.subject,
        content,
      };
      if (mail.ics) {
        content.push({
          type: `text/calendar; method=${mail.ics.method}`,
          value: mail.ics.content,
        });
        body.attachments = [
          {
            filename: 'invite.ics',
            content: b64(mail.ics.content),
            type: `text/calendar; method=${mail.ics.method}; charset=UTF-8`,
            disposition: 'attachment',
          },
        ];
      }
      if (mail.log_key) {
        // SendGrid's v3 mail/send has no true idempotency header (unlike
        // Resend) — custom_args only tags the send for later lookup via the
        // Activity API/webhooks. Residual risk (sweep item P2-20): a crash
        // after SendGrid accepts the request but before this call returns
        // can still cause a retry-driven duplicate send; there's no
        // provider-side guard against that on this path.
        body.custom_args = { idempotency_key: mail.log_key };
      }
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`sendgrid ${res.status}: ${await res.text()}`);
      return { providerMessageId: res.headers.get('x-message-id') ?? 'sendgrid' };
    },
  };
}

/** DEV_MODE provider — logs instead of sending so local dev needs no key */
export function createConsoleProvider(): EmailProvider {
  return {
    async send(mail) {
      console.log(
        `[email:dev] to=${mail.to} subject=${mail.subject}${mail.ics ? ` ics=${mail.ics.method}` : ''}\n${mail.text}`,
      );
      return { providerMessageId: `dev-${crypto.randomUUID()}` };
    },
  };
}

export interface ProviderEnv {
  RESEND_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  EMAIL_FROM?: string;
  DEV_MODE?: string;
}

/** Ordinary transactional mail: Resend, console in dev. */
export function selectProvider(env: ProviderEnv): EmailProvider {
  const from = env.EMAIL_FROM ?? 'KMS <no-reply@example.com>';
  if (env.RESEND_API_KEY && env.DEV_MODE !== 'on') {
    return createResendProvider(env.RESEND_API_KEY, from);
  }
  return createConsoleProvider();
}

/** Invite mail: SendGrid when configured (spike verdict), else the fallback chain. */
export function selectCalendarProvider(env: ProviderEnv): EmailProvider {
  const from = env.EMAIL_FROM ?? 'KMS <no-reply@example.com>';
  if (env.DEV_MODE === 'on') return createConsoleProvider();
  if (env.SENDGRID_API_KEY) return createSendGridProvider(env.SENDGRID_API_KEY, from);
  if (env.RESEND_API_KEY) return createResendProvider(env.RESEND_API_KEY, from);
  return createConsoleProvider();
}

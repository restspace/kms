// Email provider seam (docs/03 §1): Resend for transactional mail. Calendar invites will
// use a second, calendar-safe provider (spike verdict, docs/12 M0) — added in M2.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  send(mail: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

export function createResendProvider(apiKey: string, from: string): EmailProvider {
  return {
    async send(mail) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { id: string };
      return { providerMessageId: body.id };
    },
  };
}

/** DEV_MODE provider — logs instead of sending so local dev needs no key */
export function createConsoleProvider(): EmailProvider {
  return {
    async send(mail) {
      console.log(`[email:dev] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
      return { providerMessageId: `dev-${crypto.randomUUID()}` };
    },
  };
}

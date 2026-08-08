// M0 spike, variant B — invite via Resend SMTP + nodemailer icalEvent.
// Variant A (ics-invite.mjs, REST API attachment) rendered as a preview without RSVP in
// Outlook: the attachment-only MIME shape lacks the text/calendar ALTERNATIVE body part.
// nodemailer's icalEvent builds the proper multipart/alternative structure.
//
//   node spikes/ics-invite-smtp.mjs request|update|cancel
//
// New UID (-0002) so clients treat this as a fresh event, independent of variant A.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(
  readFileSync(resolve(root, '.dev.vars'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const recipients = readFileSync(resolve(root, 'test-emails.txt'), 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const FROM = env.EMAIL_FROM;
const organizerEmail = (FROM.match(/<(.+)>/) || [null, FROM])[1];

const modes = {
  request: {
    seq: 0, method: 'REQUEST',
    start: '20260810T160000Z', end: '20260810T163000Z',
    subject: 'KMS ICS spike B — Test Session',
    note: 'Initial invite (SEQUENCE 0, SMTP variant). Expect a native invite box with RSVP buttons.',
  },
  update: {
    seq: 1, method: 'REQUEST',
    start: '20260810T170000Z', end: '20260810T173000Z',
    subject: 'Updated: KMS ICS spike B — Test Session',
    note: 'Moved one hour later (SEQUENCE 1). The existing calendar entry should update in place, not duplicate.',
  },
  cancel: {
    seq: 2, method: 'CANCEL',
    start: '20260810T170000Z', end: '20260810T173000Z',
    subject: 'Cancelled: KMS ICS spike B — Test Session',
    note: 'Cancellation (SEQUENCE 2, METHOD:CANCEL). The event should disappear or show as cancelled.',
  },
};

const mode = process.argv[2] || 'request';
const cfg = modes[mode];
if (!cfg) {
  console.error('usage: node spikes/ics-invite-smtp.mjs request|update|cancel');
  process.exit(1);
}

const UID = 'kms-ics-spike-0002@mail-test.secureclaw.co.uk';
const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const fold = (line) => {
  let out = '';
  while (line.length > 74) {
    out += line.slice(0, 74) + '\r\n ';
    line = line.slice(74);
  }
  return out + line;
};

const ics =
  [
    'BEGIN:VCALENDAR',
    'PRODID:-//KMS//ICS Spike//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${cfg.method}`,
    'BEGIN:VEVENT',
    `UID:${UID}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${cfg.start}`,
    `DTEND:${cfg.end}`,
    `SEQUENCE:${cfg.seq}`,
    `SUMMARY:${cfg.subject.replace(/^(Updated|Cancelled): /, '')}`,
    'LOCATION:Main Stage',
    `DESCRIPTION:M0 spike verifying native calendar invite rendering. ${cfg.note}`,
    cfg.method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    `ORGANIZER;CN=AI.Engineer CFP:mailto:${organizerEmail}`,
    ...recipients.map(
      (r) =>
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${r}:mailto:${r}`,
    ),
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n') + '\r\n';

const transporter = nodemailer.createTransport({
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  auth: { user: 'resend', pass: env.RESEND_API_KEY },
});

const bodyText = `This is the KMS M0 calendar-invite spike (SMTP variant). ${cfg.note}`;

for (const to of recipients) {
  try {
    const info = await transporter.sendMail({
      from: FROM,
      to,
      subject: cfg.subject,
      text: bodyText,
      html: `<p>${bodyText}</p>`,
      icalEvent: { method: cfg.method, content: ics },
    });
    console.log(`${to}: sent ${info.messageId}`);
  } catch (err) {
    console.log(`${to}: FAILED ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}
transporter.close();

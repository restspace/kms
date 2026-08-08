// M0 spike, variant C — invite via direct SMTP (a warmed Workspace/M365 mailbox),
// bypassing Resend entirely. If Outlook renders RSVP here, the MIME shape is correct
// and Resend's pipeline is confirmed as the component stripping the calendar part.
//
// Needs in .dev.vars:
//   SPIKE_SMTP_HOST=smtp.gmail.com        (or smtp.office365.com)
//   SPIKE_SMTP_PORT=465                   (465 = TLS; 587 = STARTTLS)
//   SPIKE_SMTP_USER=warmedbox@domain.com
//   SPIKE_SMTP_PASS=app-password
//
// From/organizer = SPIKE_SMTP_USER (Gmail/M365 reject a mismatched From).
//
//   node spikes/ics-invite-direct.mjs request|update|cancel

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

for (const k of ['SPIKE_SMTP_HOST', 'SPIKE_SMTP_USER', 'SPIKE_SMTP_PASS']) {
  if (!env[k]) {
    console.error(`Missing ${k} in .dev.vars — add the warmed mailbox SMTP settings first.`);
    process.exit(1);
  }
}

const recipients = readFileSync(resolve(root, 'test-emails.txt'), 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const sender = env.SPIKE_SMTP_USER;

const modes = {
  request: {
    seq: 0, method: 'REQUEST',
    start: '20260810T160000Z', end: '20260810T163000Z',
    subject: 'KMS ICS spike C — Test Session',
    note: 'Initial invite (SEQUENCE 0, direct SMTP variant). Expect a native invite box with RSVP buttons.',
  },
  update: {
    seq: 1, method: 'REQUEST',
    start: '20260810T170000Z', end: '20260810T173000Z',
    subject: 'Updated: KMS ICS spike C — Test Session',
    note: 'Moved one hour later (SEQUENCE 1). The existing calendar entry should update in place, not duplicate.',
  },
  cancel: {
    seq: 2, method: 'CANCEL',
    start: '20260810T170000Z', end: '20260810T173000Z',
    subject: 'Cancelled: KMS ICS spike C — Test Session',
    note: 'Cancellation (SEQUENCE 2, METHOD:CANCEL). The event should disappear or show as cancelled.',
  },
};

const mode = process.argv[2] || 'request';
const cfg = modes[mode];
if (!cfg) {
  console.error('usage: node spikes/ics-invite-direct.mjs request|update|cancel');
  process.exit(1);
}

const UID = 'kms-ics-spike-0003@mail-test.secureclaw.co.uk';
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
    `ORGANIZER;CN=KMS Spike:mailto:${sender}`,
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

const port = Number(env.SPIKE_SMTP_PORT || 465);
const transporter = nodemailer.createTransport({
  host: env.SPIKE_SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: sender, pass: env.SPIKE_SMTP_PASS },
});

const bodyText = `This is the KMS M0 calendar-invite spike (direct SMTP variant). ${cfg.note}`;

for (const to of recipients) {
  try {
    const info = await transporter.sendMail({
      from: `KMS Spike <${sender}>`,
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

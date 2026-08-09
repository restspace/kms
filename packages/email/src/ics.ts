// RFC 5545 invite builder (docs/08 §5), carrying forward the M0 spike shape:
// stable UID, incrementing SEQUENCE, METHOD:REQUEST/CANCEL, 75-octet folding.
// Times are emitted with a VTIMEZONE for the event zone (not converted to
// UTC) so invites stay correct across DST.

export interface IcsAttendee {
  name: string;
  email: string;
}

export interface IcsOptions {
  uid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  /** IANA zone, e.g. America/Los_Angeles */
  timezone: string;
  /** local wall-clock in the event zone, e.g. '2026-10-12T09:00:00' */
  startsAtLocal: string;
  endsAtLocal: string;
  /** UTC instants used when no bundled VTIMEZONE definition exists. */
  startsAtUtc?: string;
  endsAtUtc?: string;
  summary: string;
  location: string;
  description: string;
  organizerName: string;
  organizerEmail: string;
  attendees: IcsAttendee[];
}

/** RFC 5545 §3.1 — fold content lines at 75 octets with CRLF + space. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).byteLength;
    if (octets + size > 75 && current !== '') {
      chunks.push(current);
      current = ` ${char}`;
      octets = 1 + size; // continuation lines begin with one folding space
    } else {
      current += char;
      octets += size;
    }
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

/** Escape per RFC 5545 §3.3.11 (TEXT). */
function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const localStamp = (isoLocal: string): string => isoLocal.replace(/[-:]/g, '').slice(0, 15);

const utcStamp = (isoUtc: string): string =>
  new Date(isoUtc).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Minimal VTIMEZONE definitions for common US/EU zones. Clients mostly carry
 * their own zone db, but a VTIMEZONE block keeps strict parsers happy. Zones
 * not listed fall back to UTC emission of the same wall-clock (documented
 * limitation until a zone-db dependency is justified).
 */
const VTIMEZONES: Record<string, string[]> = {
  'America/Los_Angeles': [
    'BEGIN:VTIMEZONE',
    'TZID:America/Los_Angeles',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'TZNAME:PDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'TZNAME:PST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'America/New_York': [
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'TZNAME:EDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'TZNAME:EST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'Europe/London': [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/London',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'TZNAME:BST',
    'DTSTART:19700329T010000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'TZNAME:GMT',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
};

export function buildIcs(opts: IcsOptions): string {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const tz = VTIMEZONES[opts.timezone];
  const dtField = (name: string, isoLocal: string, isoUtc: string | undefined): string => {
    if (tz) return `${name};TZID=${opts.timezone}:${localStamp(isoLocal)}`;
    if (!isoUtc) {
      throw new Error(`UTC instant is required for unsupported timezone ${opts.timezone}`);
    }
    return `${name}:${utcStamp(isoUtc)}`;
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//KMS//Event Program//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${opts.method}`,
    ...(tz ?? []),
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${dtstamp}`,
    dtField('DTSTART', opts.startsAtLocal, opts.startsAtUtc),
    dtField('DTEND', opts.endsAtLocal, opts.endsAtUtc),
    `SEQUENCE:${opts.sequence}`,
    `SUMMARY:${icsEscape(opts.summary)}`,
    `LOCATION:${icsEscape(opts.location)}`,
    `DESCRIPTION:${icsEscape(opts.description)}`,
    opts.method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    `ORGANIZER;CN=${icsEscape(opts.organizerName)}:mailto:${opts.organizerEmail}`,
    ...opts.attendees.map(
      (a) =>
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${icsEscape(a.name)}:mailto:${a.email}`,
    ),
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** UTC compact stamp (YYYYMMDDTHHMMSSZ) for calendar deep links. */
/** Fallback "add to calendar" links for clients that hide the invite part. */
export function calendarLinks(opts: {
  title: string;
  startsAtUtc: string;
  endsAtUtc: string;
  description: string;
  location: string;
}): { google_url: string; outlook_url: string } {
  const google = new URL('https://calendar.google.com/calendar/render');
  google.searchParams.set('action', 'TEMPLATE');
  google.searchParams.set('text', opts.title);
  google.searchParams.set('dates', `${utcStamp(opts.startsAtUtc)}/${utcStamp(opts.endsAtUtc)}`);
  google.searchParams.set('details', opts.description);
  google.searchParams.set('location', opts.location);

  const outlook = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  outlook.searchParams.set('subject', opts.title);
  outlook.searchParams.set('startdt', opts.startsAtUtc);
  outlook.searchParams.set('enddt', opts.endsAtUtc);
  outlook.searchParams.set('body', opts.description);
  outlook.searchParams.set('location', opts.location);

  return { google_url: google.toString(), outlook_url: outlook.toString() };
}

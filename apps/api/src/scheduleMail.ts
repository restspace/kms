// Calendar-invite emails (docs/08 §5): schedule_confirmed / _changed /
// _cancelled with the RFC-5545 payload. Built in M2 alongside the pipeline;
// the agenda (M4) calls it whenever a session is scheduled, moved or
// unscheduled. UID is stable per (session, contact) and SEQUENCE increments
// on every re-send, so client calendars update in place — the behaviour the
// M0 spike verified.

import type { Context } from 'hono';
import { buildIcs, calendarLinks } from '@kms/email';
import type { AppEnv } from './env';
import { sendTemplated } from './mailer';

export type ScheduleMailKind = 'confirmed' | 'changed' | 'cancelled';

interface SessionRow {
  id: string;
  event_id: string;
  code: string;
  title: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  room_name: string | null;
  event_name: string;
  event_slug: string;
  event_location: string | null;
  event_timezone: string;
}

interface SpeakerRow {
  contact_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

/** UTC instant → local wall-clock ISO (YYYY-MM-DDTHH:mm:ss) in `timeZone`. */
function utcToLocalIso(isoUtc: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(isoUtc));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

function fmtLocal(isoUtc: string, timeZone: string): string {
  return new Date(isoUtc).toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Send the appropriate invite email to every speaker on a session. Safe to
 * call repeatedly: each (speaker, session, sequence) sends at most once.
 * Returns the number of invites queued.
 */
export async function sendScheduleEmails(
  c: Context<AppEnv>,
  submissionId: string,
  kind: ScheduleMailKind,
): Promise<number> {
  const db = c.env.DB;
  const session = await db
    .prepare(
      `SELECT s.id, s.event_id, s.code, s.title, s.description, s.starts_at, s.ends_at,
              r.name AS room_name, e.name AS event_name, e.slug AS event_slug,
              e.location AS event_location, e.timezone AS event_timezone
       FROM submissions s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN rooms r ON r.id = s.room_id
       WHERE s.id = ?`,
    )
    .bind(submissionId)
    .first<SessionRow>();
  if (!session || !session.starts_at || !session.ends_at) return 0;

  const { results: speakers } = await db
    .prepare(
      `SELECT DISTINCT c.id AS contact_id, c.email, c.first_name, c.last_name
       FROM submission_participants sp
       JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ?`,
    )
    .bind(submissionId)
    .all<SpeakerRow>();
  if (speakers.length === 0) return 0;

  const domain = (() => {
    try {
      return new URL(c.env.APP_URL).hostname;
    } catch {
      return 'kms.local';
    }
  })();
  const method = kind === 'cancelled' ? 'CANCEL' : 'REQUEST';
  const organizerEmail = (c.env.EMAIL_FROM ?? 'no-reply@example.com').replace(/^.*<|>$/g, '');
  const location = [session.room_name, session.event_location].filter(Boolean).join(', ') || session.event_name;
  const plainDescription =
    (session.description ?? '').replace(/<[^>]*>/g, '').slice(0, 500) +
    `\n\nSpeaker portal: ${c.env.APP_URL}/portal/${session.event_slug}`;
  const links = calendarLinks({
    title: `${session.title} — ${session.event_name}`,
    startsAtUtc: session.starts_at,
    endsAtUtc: session.ends_at,
    description: plainDescription,
    location,
  });

  let queued = 0;
  for (const speaker of speakers) {
    // Stable UID per (session, contact); SEQUENCE increments on every send
    // after the first so clients replace the entry (docs/02 §7).
    const uid = `${session.id}-${speaker.contact_id}@${session.event_slug}.${domain}`;
    const existing = await db
      .prepare('SELECT id, sequence FROM calendar_invites WHERE session_id = ? AND contact_id = ?')
      .bind(session.id, speaker.contact_id)
      .first<{ id: string; sequence: number }>();
    const sequence = existing ? existing.sequence + 1 : 0;
    const ts = new Date().toISOString();
    if (existing) {
      await db
        .prepare('UPDATE calendar_invites SET sequence = ?, method = ?, last_sent_at = ? WHERE id = ?')
        .bind(sequence, method, ts, existing.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO calendar_invites (id, session_id, contact_id, uid, sequence, method, last_sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), session.id, speaker.contact_id, uid, sequence, method, ts)
        .run();
    }

    const speakerName = [speaker.first_name, speaker.last_name].filter(Boolean).join(' ') || speaker.email;
    const ics = buildIcs({
      uid,
      sequence,
      method,
      timezone: session.event_timezone,
      startsAtLocal: utcToLocalIso(session.starts_at, session.event_timezone),
      endsAtLocal: utcToLocalIso(session.ends_at, session.event_timezone),
      summary: `${session.title} — ${session.event_name}`,
      location,
      description: plainDescription,
      organizerName: session.event_name,
      organizerEmail,
      attendees: [{ name: speakerName, email: speaker.email }],
    });

    const outcome = await sendTemplated(c, {
      templateKey: `schedule_${kind}`,
      eventId: session.event_id,
      contactId: speaker.contact_id,
      toEmail: speaker.email,
      entityId: session.id,
      version: sequence, // each schedule change is a distinct send
      context: {
        event: { name: session.event_name, location: session.event_location ?? '' },
        speaker: { first_name: speaker.first_name ?? 'there', full_name: speakerName },
        submission: { title: session.title, code: session.code },
        session: {
          starts_at: fmtLocal(session.starts_at, session.event_timezone),
          ends_at: fmtLocal(session.ends_at, session.event_timezone),
          room: session.room_name ?? 'TBC',
        },
        calendar: links,
        portal_url: `${c.env.APP_URL}/portal/${session.event_slug}`,
      },
      ics: { content: ics, method },
    });
    if (outcome === 'queued') queued += 1;
  }
  return queued;
}

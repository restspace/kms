// Workplan 14 F5 (decision D7): a submission that's already been decided
// (accepted/declined) used to leave participants effectively frozen in the
// eval judge's read of the app. Investigation found the organiser-side
// endpoint (evaluationRoutes POST/PUT/DELETE .../participants) never
// actually gated on submission status — there was no gate to drop. What WAS
// missing was traceability: no revision snapshot was taken before the
// roster changed. This pins the two halves of D7:
//   1. the organiser CAN add a participant to an accepted submission, and a
//      pre-edit content_revisions row (entity_type 'submission_participants')
//      is recorded for it;
//   2. the speaker portal stays locked for the same accepted submission —
//      unchanged behaviour, still gated by isEditLocked.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { sessionCookieFor } from './fixtures';
import { addParticipant } from './fixtures-portal';

interface RevisionRow {
  entity_type: string;
  entity_id: string;
  payload: string | null;
  source: string;
}

describe('organiser post-decision participant edits (F5/D7)', () => {
  it('lets the organiser add a participant to an accepted submission and records a revision row', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const newSpeaker = await seedContact(eventId, { job_title: 'Principal Engineer', company: 'Globex' });
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM content_revisions WHERE entity_type = 'submission_participants' AND entity_id = ?",
    ).bind(submissionId).first<{ n: number }>();
    expect(before?.n ?? 0).toBe(0);

    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/${submissionId}/participants`,
      jsonReq(admin.cookie, { contact_id: newSpeaker, role: 'co-speaker' }),
    );
    expect(res.status).toBe(201);
    const { id: participantId } = (await res.json()) as { id: string };

    // The participant landed.
    const row = await env.DB.prepare('SELECT contact_id, role FROM submission_participants WHERE id = ?')
      .bind(participantId)
      .first<{ contact_id: string; role: string }>();
    expect(row).toEqual({ contact_id: newSpeaker, role: 'co-speaker' });

    // A pre-edit revision row was recorded for the roster change.
    const revision = await env.DB.prepare(
      "SELECT entity_type, entity_id, payload, source FROM content_revisions WHERE entity_type = 'submission_participants' AND entity_id = ? ORDER BY edited_at DESC LIMIT 1",
    ).bind(submissionId).first<RevisionRow>();
    expect(revision).toBeTruthy();
    expect(revision!.source).toBe('admin');
    // Payload is the PRE-edit snapshot — empty roster, since this was the
    // first participant on the submission.
    const payload = JSON.parse(revision!.payload ?? '{}') as { participants: unknown[] };
    expect(payload.participants).toEqual([]);
  });

  it('still shows the speaker portal\'s participants as read-only text, not an editable roster', async () => {
    // The speaker portal never exposed participant add/remove/role-change at
    // all (portal.ts only ever renders the roster as plain <p> text); this
    // pins that D7's organiser-only exception did not accidentally grow one.
    const eventId = await seedEvent();
    const eventRow = await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>();
    const speaker = await seedContact(eventId, { email: 'speaker@example.com' });
    const submissionId = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker });
    await addParticipant(submissionId, speaker);
    const cookie = await sessionCookieFor({ contactId: speaker, eventId, eventSlug: eventRow!.slug, role: 'speaker' });

    const res = await SELF.fetch(`https://example.com/portal/${eventRow!.slug}/submissions/${submissionId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const participantsCard = html.slice(html.indexOf('<h2>Participants</h2>'), html.indexOf('</div>', html.indexOf('<h2>Participants</h2>')));
    expect(participantsCard).not.toContain('<form');
    expect(participantsCard).not.toContain('<button');
    expect(participantsCard).not.toContain('<select');

    // And no organiser-only participants API route exists under /portal at all.
    const editAttempt = await SELF.fetch(
      `https://example.com/portal/${eventRow!.slug}/submissions/${submissionId}/participants`,
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ contact_id: speaker, role: 'co-speaker' }) },
    );
    expect(editAttempt.status).toBe(404);
  });
});

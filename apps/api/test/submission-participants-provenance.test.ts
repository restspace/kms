// Workplan 13 W1c (D3): title_at_time / org_at_time freeze what the event's
// profile said when the participant row was created. The profile row stays
// current truth and editable — editing it must not rewrite history on the
// join row.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

interface ParticipantRow {
  title_at_time: string | null;
  org_at_time: string | null;
}

const participantRow = (id: string) =>
  env.DB.prepare('SELECT title_at_time, org_at_time FROM submission_participants WHERE id = ?')
    .bind(id)
    .first<ParticipantRow>();

describe('submission participant provenance (W1c)', () => {
  it('stamps the admin participant add from the contributing event_contacts row', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { job_title: 'Staff Engineer', company: 'Initech' });
    const submissionId = await seedSubmission(eventId);

    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/${submissionId}/participants`,
      jsonReq(admin.cookie, { contact_id: speaker, role: 'speaker' }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    expect(await participantRow(id)).toEqual({ title_at_time: 'Staff Engineer', org_at_time: 'Initech' });
  });

  it('survives a later edit to the contact\'s current job title and company', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { job_title: 'Senior Developer', company: 'Acme 2019' });
    const submissionId = await seedSubmission(eventId);

    const created = await SELF.fetch(
      `https://example.com/app/api/submissions/${submissionId}/participants`,
      jsonReq(admin.cookie, { contact_id: speaker, role: 'speaker' }),
    );
    const { id } = (await created.json()) as { id: string };

    // The portal "fix my job title" flow — current truth moves…
    const updated = await SELF.fetch(
      `https://example.com/app/api/contacts/${speaker}`,
      jsonReq(admin.cookie, { job_title: 'VP of Engineering', company: 'Acme 2026' }, 'PUT'),
    );
    expect(updated.status).toBe(200);
    const profile = await env.DB.prepare(
      'SELECT job_title, company FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventId, speaker).first<{ job_title: string; company: string }>();
    expect(profile).toEqual({ job_title: 'VP of Engineering', company: 'Acme 2026' });

    // …but the join row keeps what was true when they were linked.
    expect(await participantRow(id)).toEqual({ title_at_time: 'Senior Developer', org_at_time: 'Acme 2019' });
  });
});

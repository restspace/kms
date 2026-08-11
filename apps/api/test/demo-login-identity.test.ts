// Contacts-hygiene item 5 (workplan-4): the landing page's demo speaker
// login must always advertise a contact who actually has a name — a nameless
// "account-step stub" (submit.tsx's `/account` upsert, or a form with no
// participant-name step) sorts into the `ORDER BY created_at, email` race
// exactly like a real seeded speaker, and would advertise an email nobody
// meaningfully lands on. `demoLogins` has no event_id parameter (docs/12 §2:
// it always reads "the" demo event, singular) — this file seeds exactly one
// event so that assumption holds for the test too; see vitest.config.ts's
// storage-persists-within-a-file caution.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedContact, seedEvent, seedEventUser, seedSubmission } from './fixtures-admin';
import { demoLogins } from '../src/routes/landing';

describe('demoLogins speaker candidate (item 5)', () => {
  it('skips a nameless stub even when it sorts before the real speaker', async () => {
    const eventId = await seedEvent({ id: 'evt-demo-hygiene' });

    // A nameless stub with an *earlier* created_at than the real speaker —
    // exactly the ordering that used to let it win the
    // `ORDER BY created_at, email LIMIT 1` race and get advertised as the
    // demo speaker login with no one to actually sign in as.
    //
    // Seeded through seedContact so it is a full member of this event's roster
    // (contact + event_contacts). Inserting a bare org-level contact would make
    // the stub fail demoLogins' event_contacts join instead of its name check,
    // and the test would pass without exercising item 5 at all.
    await seedContact(eventId, {
      id: 'con-stub-early',
      email: 'aaa-stub@example.com',
      first_name: '',
      last_name: '',
    });
    await env.DB.prepare(
      `UPDATE contacts SET created_at = '2020-01-01T00:00:00Z', updated_at = '2020-01-01T00:00:00Z' WHERE id = ?`,
    ).bind('con-stub-early').run();
    await seedSubmission(eventId, { submitter_contact_id: 'con-stub-early', created_at: '2020-01-01T00:00:00Z' });

    const named = await seedContact(eventId, { email: 'zzz-named@example.com', first_name: 'Priya', last_name: 'Raman' });
    await seedSubmission(eventId, { submitter_contact_id: named });

    // An organiser, so the assertion below proves BOTH advertised demo logins
    // resolve against the org-scoped schema, not just the speaker one.
    const organiser = await seedContact(eventId, {
      email: 'organiser@example.com',
      first_name: 'Owen',
      last_name: 'Ner',
    });
    await seedEventUser(eventId, organiser, 'owner');

    const logins = await demoLogins(env.DB);
    expect(logins?.eventSlug).toBeDefined();
    expect(logins?.speakerEmail).toBe('zzz-named@example.com');
    expect(logins?.adminEmail).toBe('organiser@example.com');
  });
});

// Lane O1 — three persistence/correctness defects the automated eval found in
// the evaluation feature:
//
//   ABS-07  the per-round "Hide submitter identities from reviewers" flag did
//           not survive a refetch, and the reviewer's payload carried the
//           submitter's name anyway ("Priya Raman (speaker)").
//   pool    unchecking a reviewer from a round's pool never persisted — there
//           was no remove endpoint at all, only the additive assign path.
//   CFP-11  "Send sign-in link" surfaced a link that did not belong to the
//           reviewer it was clicked for.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

async function makePlan(cookie: string, name = 'Round 1'): Promise<string> {
  const res = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(cookie, { name }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const overview = async (cookie: string) =>
  (await (await SELF.fetch(`${base}/evaluation/overview`, { headers: { cookie } })).json()) as {
    plans: Array<{ id: string; anonymise_submitters: number }>;
    pool: Array<{ plan_id: string; contact_id: string }>;
  };

async function addAll(cookie: string, planId: string): Promise<void> {
  const res = await SELF.fetch(
    `${base}/evaluation/plans/${planId}/submissions`,
    jsonReq(cookie, { mode: 'add', filter: {} }),
  );
  expect(res.status).toBe(200);
}

/** A round with one submission, one named participant and one assigned reviewer. */
async function roundWithNamedSpeaker(anonymise: boolean) {
  const eventId = await seedEvent();
  const admin = await seedStaff(eventId, 'admin');
  const reviewer = await seedStaff(eventId, 'reviewer');
  const speaker = await seedContact(eventId, {
    email: `priya-${crypto.randomUUID().slice(0, 8)}@example.com`,
    first_name: 'Priya',
    last_name: 'Raman',
  });
  const submissionId = await seedSubmission(eventId, { title: 'Observability at scale', submitter_contact_id: speaker });
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 0, 1)`,
  ).bind(crypto.randomUUID(), submissionId, speaker).run();

  const planId = await makePlan(admin.cookie);
  await addAll(admin.cookie, planId);
  await SELF.fetch(
    `${base}/evaluation/plans/${planId}/assign`,
    jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
  );
  // Explicit either way (rather than relying on the column default): new
  // plans now default to anonymise_submitters=1 at creation, so "not
  // anonymised" has to opt out explicitly, same as "anonymised" opts in.
  const put = await SELF.fetch(
    `${base}/evaluation/plans/${planId}`,
    jsonReq(admin.cookie, { anonymise_submitters: anonymise }, 'PUT'),
  );
  expect(put.status).toBe(200);
  return { eventId, admin, reviewer, planId, submissionId, speaker };
}

describe('anonymise submitters (ABS-07)', () => {
  it('persists the flag and reads it back through the overview', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie);

    const on = await SELF.fetch(
      `${base}/evaluation/plans/${planId}`,
      jsonReq(admin.cookie, { anonymise_submitters: true }, 'PUT'),
    );
    expect(on.status).toBe(200);
    expect(
      await env.DB.prepare('SELECT anonymise_submitters AS a FROM evaluation_plans WHERE id = ?')
        .bind(planId)
        .first<{ a: number }>(),
    ).toMatchObject({ a: 1 });
    expect((await overview(admin.cookie)).plans.find((p) => p.id === planId)?.anonymise_submitters).toBe(1);

    // …and it can be turned back off (the checkbox is not one-way).
    const off = await SELF.fetch(
      `${base}/evaluation/plans/${planId}`,
      jsonReq(admin.cookie, { anonymise_submitters: false }, 'PUT'),
    );
    expect(off.status).toBe(200);
    expect((await overview(admin.cookie)).plans.find((p) => p.id === planId)?.anonymise_submitters).toBe(0);
  });

  it('also accepts the 0/1 form a raw client may send', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie);
    await SELF.fetch(`${base}/evaluation/plans/${planId}`, jsonReq(admin.cookie, { anonymise_submitters: 1 }, 'PUT'));
    expect((await overview(admin.cookie)).plans.find((p) => p.id === planId)?.anonymise_submitters).toBe(1);
  });

  it('redacts submitter identity from the reviewer payload server-side', async () => {
    const { reviewer, submissionId } = await roundWithNamedSpeaker(true);
    const queue = (await (
      await SELF.fetch(`${base}/review/queue`, { headers: { cookie: reviewer.cookie } })
    ).json()) as {
      assignments: Array<Record<string, unknown>>;
      participants: Record<string, unknown[]>;
    };
    const mine = queue.assignments.find((a) => a.submission_id === submissionId);
    expect(mine).toBeTruthy();
    expect(mine?.anonymise_submitters).toBe(1);
    expect(queue.participants[submissionId] ?? []).toEqual([]);
    // Nothing anywhere in the payload may carry the identity.
    const serialised = JSON.stringify(queue);
    expect(serialised).not.toContain('Priya');
    expect(serialised).not.toContain('Raman');
    expect(serialised).not.toContain('@example.com');
  });

  it('still shows participants when the round is not anonymised', async () => {
    const { reviewer, submissionId } = await roundWithNamedSpeaker(false);
    const queue = (await (
      await SELF.fetch(`${base}/review/queue`, { headers: { cookie: reviewer.cookie } })
    ).json()) as { participants: Record<string, Array<{ name: string; role: string }>> };
    expect(queue.participants[submissionId]).toEqual([{ name: 'Priya Raman', role: 'speaker' }]);
  });
});

describe('reviewer pool membership', () => {
  it('removing a reviewer from the pool persists and takes their open assignments', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const keep = await seedStaff(eventId, 'reviewer');
    const drop = await seedStaff(eventId, 'reviewer');
    await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await addAll(admin.cookie, planId);
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [keep.contactId, drop.contactId], strategy: 'all' }),
    );
    expect((await overview(admin.cookie)).pool.filter((p) => p.plan_id === planId).length).toBe(2);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/reviewers/${drop.contactId}`,
      { method: 'DELETE', headers: { cookie: admin.cookie } },
    );
    expect(res.status).toBe(200);

    const pool = (await overview(admin.cookie)).pool.filter((p) => p.plan_id === planId);
    expect(pool.map((p) => p.contact_id)).toEqual([keep.contactId]);
    const left = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM review_assignments WHERE plan_id = ? AND reviewer_contact_id = ?')
      .bind(planId, drop.contactId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('keeps a reviewer whose work is already done, so their scores are not orphaned', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await addAll(admin.cookie, planId);
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    await env.DB
      .prepare(`UPDATE review_assignments SET status = 'complete' WHERE plan_id = ? AND reviewer_contact_id = ?`)
      .bind(planId, reviewer.contactId)
      .run();

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/reviewers/${reviewer.contactId}`,
      { method: 'DELETE', headers: { cookie: admin.cookie } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed_assignments: number }).toMatchObject({ removed_assignments: 0 });
    const kept = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM review_assignments WHERE plan_id = ? AND status = 'complete'`)
      .bind(planId)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  it('adds a reviewer to the pool without assigning anything', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const planId = await makePlan(admin.cookie);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/reviewers`,
      jsonReq(admin.cookie, { contact_id: reviewer.contactId }),
    );
    expect(res.status).toBe(201);
    expect((await overview(admin.cookie)).pool).toContainEqual({ plan_id: planId, contact_id: reviewer.contactId });
    const assignments = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM review_assignments WHERE plan_id = ?')
      .bind(planId)
      .first<{ n: number }>();
    expect(assignments?.n).toBe(0);
  });

  it('refuses a contact who is not seated as a reviewer on the event', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const stranger = await seedContact(eventId);
    const planId = await makePlan(admin.cookie);
    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/reviewers`,
      jsonReq(admin.cookie, { contact_id: stranger }),
    );
    expect(res.status).toBe(400);
  });
});

describe('reviewer sign-in link identity (CFP-11)', () => {
  it('mints the link for the target reviewer, never the signed-in organiser', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const email = `sam-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const { id: reviewerId } = (await (
      await SELF.fetch(`${base}/evaluation/reviewers`, jsonReq(admin.cookie, { name: 'Sam Whitfield', email }))
    ).json()) as { id: string };

    const res = await SELF.fetch(`${base}/evaluation/reviewers/${reviewerId}/signin-link`, jsonReq(admin.cookie, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact_id: string; email: string; name: string | null; dev_link: string | null;
    };
    expect(body).toMatchObject({ contact_id: reviewerId, email, name: 'Sam Whitfield' });
    expect(body.dev_link).toBeTruthy();

    // The surfaced link must resolve to the reviewer's contact, not the admin's.
    const token = new URL(body.dev_link!).searchParams.get('t')!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const row = await env.DB
      .prepare('SELECT contact_id, event_id FROM auth_tokens WHERE token_hash = ?')
      .bind(hash)
      .first<{ contact_id: string; event_id: string }>();
    expect(row).toMatchObject({ contact_id: reviewerId, event_id: eventId });
    expect(row?.contact_id).not.toBe(admin.contactId);
  });

  // The demo instance is the case that actually failed: DEV_MODE off,
  // DEMO_RESET on, so auth.ts's carve-out only ever surfaces a link for the
  // two seeded demo identities and a real reviewer got `dev_link: null`.
  it('surfaces the target reviewer’s link on a demo instance', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const mutable = env as unknown as Record<string, string>;
    const before = { dev: mutable.DEV_MODE, demo: mutable.DEMO_RESET };
    mutable.DEV_MODE = 'off';
    mutable.DEMO_RESET = 'on';
    try {
      const res = await SELF.fetch(
        `${base}/evaluation/reviewers/${reviewer.contactId}/signin-link`,
        jsonReq(admin.cookie, {}),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { contact_id: string; dev_link: string | null };
      expect(body.contact_id).toBe(reviewer.contactId);
      expect(body.dev_link).toBeTruthy();
      const token = new URL(body.dev_link!).searchParams.get('t')!;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const row = await env.DB
        .prepare('SELECT contact_id FROM auth_tokens WHERE token_hash = ?')
        .bind(hash)
        .first<{ contact_id: string }>();
      expect(row?.contact_id).toBe(reviewer.contactId);
    } finally {
      mutable.DEV_MODE = before.dev;
      mutable.DEMO_RESET = before.demo;
    }
  });
});

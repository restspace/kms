// GET /e/:slug/speakers/:speakerId/headshot — the one public-safe asset
// route (lane W2-D3). Same visibility rule as GET /e/:slug/speakers.json:
// event must have a published agenda, and the contact must be a participant
// on an accepted, scheduled submission. Always 404 on every negative path,
// mirroring /files/:id's "never confirm existence" convention.

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent } from './fixtures';
import { addParticipant, createFileAsset, createSubmission, setHeadshot } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

async function publishAgenda(eventId: string): Promise<void> {
  await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();
}

async function scheduleSubmission(submissionId: string): Promise<void> {
  await env.DB
    .prepare("UPDATE submissions SET starts_at = '2026-10-01T09:00:00.000Z', ends_at = '2026-10-01T10:00:00.000Z' WHERE id = ?")
    .bind(submissionId)
    .run();
}

describe('GET /e/:slug/speakers/:speakerId/headshot', () => {
  let eventId: string;
  let slug: string;
  let speakerId: string;
  let assetId: string;

  beforeEach(async () => {
    slug = `headshot-${crypto.randomUUID().slice(0, 8)}`;
    eventId = await createEvent({ slug });
    speakerId = await createContact(eventId, { email: 'speaker@example.com' });
    assetId = await createFileAsset(eventId, { uploadedBy: speakerId, filename: 'headshot.png' });
    await setHeadshot(speakerId, assetId);
    const submissionId = await createSubmission(eventId, { status: 'accepted' });
    await addParticipant(submissionId, speakerId);
    await scheduleSubmission(submissionId);
  });

  it('serves the headshot bytes with no auth once the agenda is published', async () => {
    await publishAgenda(eventId);
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/speakers/${speakerId}/headshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    // PNG magic number.
    expect([...body.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('404s when the agenda is not published', async () => {
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/speakers/${speakerId}/headshot`);
    expect(res.status).toBe(404);
  });

  it('404s for a speaker with no scheduled, accepted session even if the agenda is published', async () => {
    await publishAgenda(eventId);
    const unscheduled = await createContact(eventId, { email: 'unscheduled@example.com' });
    const asset2 = await createFileAsset(eventId, { uploadedBy: unscheduled, filename: 'other.png' });
    await setHeadshot(unscheduled, asset2);
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/speakers/${unscheduled}/headshot`);
    expect(res.status).toBe(404);
  });

  it('404s when the speaker has no headshot set', async () => {
    await publishAgenda(eventId);
    const noPhoto = await createContact(eventId, { email: 'nophoto@example.com' });
    const submissionId = await createSubmission(eventId, { status: 'accepted' });
    await addParticipant(submissionId, noPhoto);
    await scheduleSubmission(submissionId);
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/speakers/${noPhoto}/headshot`);
    expect(res.status).toBe(404);
  });

  it('404s for an unknown event slug', async () => {
    const res = await SELF.fetch(`${ORIGIN}/e/does-not-exist/speakers/${speakerId}/headshot`);
    expect(res.status).toBe(404);
  });

  it("does not leak another event's speaker headshot through this event's slug", async () => {
    await publishAgenda(eventId);
    const otherEventId = await createEvent({ slug: `other-${crypto.randomUUID().slice(0, 8)}` });
    const otherSpeaker = await createContact(otherEventId, { email: 'other-speaker@example.com' });
    const otherAsset = await createFileAsset(otherEventId, { uploadedBy: otherSpeaker, filename: 'other.png' });
    await setHeadshot(otherSpeaker, otherAsset);
    const otherSubmission = await createSubmission(otherEventId, { status: 'accepted' });
    await addParticipant(otherSubmission, otherSpeaker);
    await scheduleSubmission(otherSubmission);
    await publishAgenda(otherEventId);

    // Right asset, wrong event's slug in the URL.
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/speakers/${otherSpeaker}/headshot`);
    expect(res.status).toBe(404);
  });
});

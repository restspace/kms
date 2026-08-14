// Record-level file authorization (sweep item P1-4). Event scope alone used to
// be enough to fetch any asset id; now GET /files/:id resolves the asset's
// relation to the requester and answers 404 (never 403) when there is none.

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import {
  addParticipant,
  assignReviewer,
  completeAssignmentWith,
  createFileAsset,
  createFileRequest,
  createFileRequestUpload,
  createSubmission,
  createTaskAssignment,
  setEventLogo,
  setHeadshot,
} from './fixtures-portal';

const ORIGIN = 'https://kms.test';

interface World {
  eventId: string;
  otherEventId: string;
  contacts: Record<string, string>;
  assets: Record<string, string>;
}

let world: World;

beforeEach(async () => {
  const eventId = await createEvent({ slug: `acl-${crypto.randomUUID().slice(0, 8)}` });
  const otherEventId = await createEvent({ slug: `other-${crypto.randomUUID().slice(0, 8)}` });

  const owner = await createContact(eventId, { email: 'owner@example.com' });
  const admin = await createContact(eventId, { email: 'admin@example.com' });
  const reviewer = await createContact(eventId, { email: 'reviewer@example.com' });
  const speakerA = await createContact(eventId, { email: 'a@example.com' });
  const speakerB = await createContact(eventId, { email: 'b@example.com' });
  const outsider = await createContact(otherEventId, { email: 'outsider@example.com' });

  await createEventUser(eventId, owner, 'owner');
  await createEventUser(eventId, admin, 'admin');
  await createEventUser(eventId, reviewer, 'reviewer');

  // Headshots.
  const headshotA = await createFileAsset(eventId, { uploadedBy: speakerA, filename: 'a.png' });
  const headshotB = await createFileAsset(eventId, { uploadedBy: speakerB, filename: 'b.png' });
  await setHeadshot(speakerA, headshotA);
  await setHeadshot(speakerB, headshotB);

  // A's task upload, reachable only through task_assignments.response_id.
  const taskUploadA = await createFileAsset(eventId, { uploadedBy: null, filename: 'slides-a.pdf', contentType: 'application/pdf' });
  const assignmentA = await createTaskAssignment(eventId, speakerA, { actionType: 'file_upload' });
  await completeAssignmentWith(assignmentA, taskUploadA);

  // B's file-request upload, reachable only through file_request_uploads.
  const requestId = await createFileRequest(eventId);
  const requestUploadB = await createFileAsset(eventId, { uploadedBy: null, filename: 'contract-b.pdf', contentType: 'application/pdf' });
  await createFileRequestUpload(requestId, speakerB, requestUploadB);

  // Event branding: readable by every member.
  const logo = await createFileAsset(eventId, { uploadedBy: null, filename: 'logo.png' });
  await setEventLogo(eventId, logo);

  // The reviewer is assigned to a submission A participates in — so A's
  // headshot is in scope for them, and B's is not.
  const submissionId = await createSubmission(eventId, { submitterContactId: speakerA });
  await addParticipant(submissionId, speakerA);
  await assignReviewer(eventId, submissionId, reviewer);

  world = {
    eventId,
    otherEventId,
    contacts: { owner, admin, reviewer, speakerA, speakerB, outsider },
    assets: { headshotA, headshotB, taskUploadA, requestUploadB, logo },
  };
});

async function fetchAs(
  who: keyof World['contacts'] | string,
  role: 'owner' | 'admin' | 'reviewer' | 'speaker',
  asset: string,
  eventId?: string,
): Promise<number> {
  const cookie = await sessionCookieFor({
    contactId: world.contacts[who] as string,
    eventId: eventId ?? world.eventId,
    role,
  });
  const res = await SELF.fetch(`${ORIGIN}/files/${world.assets[asset]}`, { headers: { cookie } });
  return res.status;
}

describe('GET /files/:id decision table', () => {
  it('requires a session', async () => {
    const res = await SELF.fetch(`${ORIGIN}/files/${world.assets.headshotA}`);
    expect(res.status).toBe(401);
  });

  const cases: Array<[string, 'owner' | 'admin' | 'reviewer' | 'speaker', string, number]> = [
    // owner / admin: every asset in their event
    ['owner', 'owner', 'headshotA', 200],
    ['owner', 'owner', 'requestUploadB', 200],
    ['admin', 'admin', 'headshotB', 200],
    ['admin', 'admin', 'taskUploadA', 200],
    // reviewer: headshots of contacts on submissions they review, plus branding
    ['reviewer', 'reviewer', 'headshotA', 200],
    ['reviewer', 'reviewer', 'logo', 200],
    ['reviewer', 'reviewer', 'headshotB', 404],
    ['reviewer', 'reviewer', 'taskUploadA', 404],
    ['reviewer', 'reviewer', 'requestUploadB', 404],
    // speaker A: own headshot, own task response, branding — nothing of B's
    ['speakerA', 'speaker', 'headshotA', 200],
    ['speakerA', 'speaker', 'taskUploadA', 200],
    ['speakerA', 'speaker', 'logo', 200],
    ['speakerA', 'speaker', 'headshotB', 404],
    ['speakerA', 'speaker', 'requestUploadB', 404],
    // speaker B: own headshot and own file-request upload only
    ['speakerB', 'speaker', 'headshotB', 200],
    ['speakerB', 'speaker', 'requestUploadB', 200],
    ['speakerB', 'speaker', 'headshotA', 404],
    ['speakerB', 'speaker', 'taskUploadA', 404],
  ];

  it.each(cases)('%s (%s) fetching %s -> %i', async (who, role, asset, expected) => {
    expect(await fetchAs(who, role, asset)).toBe(expected);
  });

  it.each(['headshotA', 'logo', 'taskUploadA'])(
    'a member of another event cannot read %s',
    async (asset) => {
      expect(await fetchAs('outsider', 'speaker', asset, world.otherEventId)).toBe(404);
    },
  );

  it('answers 404 rather than 403 so denial does not confirm existence', async () => {
    const cookie = await sessionCookieFor({
      contactId: world.contacts.speakerA as string,
      eventId: world.eventId,
      role: 'speaker',
    });
    const denied = await SELF.fetch(`${ORIGIN}/files/${world.assets.headshotB}`, { headers: { cookie } });
    const missing = await SELF.fetch(`${ORIGIN}/files/does-not-exist`, { headers: { cookie } });
    expect(denied.status).toBe(missing.status);
    expect(await denied.text()).toBe(await missing.text());
  });
});

describe('GET /files/:id content-disposition', () => {
  // PDFs must render in the browser's viewer, not force a download; anything
  // that is neither an image nor a PDF stays an attachment so a stored file
  // can never execute in this origin.
  it('serves PDFs inline and images inline, other types as attachment', async () => {
    const cookie = await sessionCookieFor({
      contactId: world.contacts.admin as string,
      eventId: world.eventId,
      role: 'admin',
    });
    const docx = await createFileAsset(world.eventId, {
      uploadedBy: null,
      filename: 'notes.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const pdf = await SELF.fetch(`${ORIGIN}/files/${world.assets.taskUploadA}`, { headers: { cookie } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline;/);

    const image = await SELF.fetch(`${ORIGIN}/files/${world.assets.headshotA}`, { headers: { cookie } });
    expect(image.headers.get('content-disposition')).toMatch(/^inline;/);

    const other = await SELF.fetch(`${ORIGIN}/files/${docx}`, { headers: { cookie } });
    expect(other.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

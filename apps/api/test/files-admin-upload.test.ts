// Organiser-side upload (eval defect: a submission's Files section offered
// only "No files uploaded" text — no way to add or replace a deliverable on a
// speaker's behalf). POST /app/api/files/uploads reuses the portal's storage
// machinery (saveFile + appendUploadVersion): a new chain hangs off the
// standing per-event "Organiser uploads" request, and `upload_id` appends the
// next version to an existing chain.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { fileFrom, pdfBytes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let admin: { contactId: string; cookie: string; email: string };
let speakerId: string;
let submissionId: string;

beforeEach(async () => {
  eventId = await seedEvent();
  admin = await seedStaff(eventId, 'admin');
  speakerId = await seedContact(eventId, { email: 'speaker@example.com', first_name: 'Priya', last_name: 'Raman' });
  submissionId = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speakerId });
});

async function post(fields: Record<string, string | File>, cookie = admin.cookie): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return SELF.fetch(`${ORIGIN}/app/api/files/uploads`, { method: 'POST', headers: { cookie }, body: form });
}

describe('POST /app/api/files/uploads', () => {
  it('starts a chain on a submission and lists it in the library', async () => {
    const res = await post({ file: fileFrom(pdfBytes(), 'slides.pdf', 'application/pdf'), submission_id: submissionId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; upload_id: string; version: number };
    expect(body.version).toBe(1);

    const lib = await SELF.fetch(`${ORIGIN}/app/api/files/library?submission_id=${submissionId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    const libBody = (await lib.json()) as {
      items: Array<{ filename: string; contact_id: string; uploaded_by_email: string | null }>;
    };
    const row = libBody.items.find((i) => i.filename === 'slides.pdf');
    expect(row).toBeTruthy();
    // The chain belongs to the speaker (the file is FOR them), while the
    // actual uploader recorded on the asset is the organiser.
    expect(row?.contact_id).toBe(speakerId);
    expect(row?.uploaded_by_email).toBe(admin.email);
  });

  it('appends the next version when upload_id names an existing chain', async () => {
    const first = await post({ file: fileFrom(pdfBytes(), 'slides.pdf', 'application/pdf'), submission_id: submissionId });
    const { upload_id } = (await first.json()) as { upload_id: string };

    const second = await post({ file: fileFrom(pdfBytes(), 'slides-v2.pdf', 'application/pdf'), upload_id });
    expect(second.status).toBe(201);
    const body = (await second.json()) as { version: number; versions: Array<{ version: number; is_current: number }> };
    expect(body.version).toBe(2);
    expect(body.versions).toHaveLength(2);
    expect(body.versions.find((v) => v.is_current === 1)?.version).toBe(2);
  });

  it('refuses reviewers and requires a target', async () => {
    const reviewer = await seedStaff(eventId, 'reviewer');
    const denied = await post(
      { file: fileFrom(pdfBytes(), 'x.pdf', 'application/pdf'), submission_id: submissionId },
      reviewer.cookie,
    );
    expect(denied.status).toBe(403);

    const noTarget = await post({ file: fileFrom(pdfBytes(), 'x.pdf', 'application/pdf') });
    expect(noTarget.status).toBe(400);

    const noFile = await post({ submission_id: submissionId });
    expect(noFile.status).toBe(400);
  });
});

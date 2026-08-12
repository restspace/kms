// Regression for the "Asset completeness" widget contradicting the Tasks tab
// (docs/09 "Accepted speakers missing bio, headshot, or slides"). A speaker
// with a *completed* presentation-upload assignment plus an unrelated,
// still-open file_upload task (e.g. co-presenting a second accepted talk, or
// an organiser-added upload task) used to be flagged "missing slides" anyway
// because dashboard.ts summed *any* incomplete file_upload assignment rather
// than checking whether the slides upload itself was done.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedContact, seedEvent, seedFileAsset, seedStaff, seedSubmission, seedTask } from './fixtures-admin';
import { createFileRequest, createFileRequestUpload } from './fixtures-portal';

const getDashboard = (cookie: string) =>
  SELF.fetch('https://example.com/app/api/dashboard', { headers: { cookie, accept: 'application/json' } });

async function assignTask(taskId: string, contactId: string, status: string) {
  await env.DB.prepare(
    'INSERT INTO task_assignments (id, task_id, contact_id, status, completed_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(`ta-${crypto.randomUUID()}`, taskId, contactId, status, status === 'complete' ? '2026-08-01T00:00:00Z' : null)
    .run();
}

describe('GET /app/api/dashboard — asset completeness', () => {
  it('does not flag missing slides once the presentation-upload task is complete, even with another open file_upload task', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'twotalks@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, submission, speaker).run();

    const slidesTask = await seedTask(eventId, { title: 'Presentation Upload', action_type: 'file_upload' });
    const otherUploadTask = await seedTask(eventId, { title: 'W9 Tax Form', action_type: 'file_upload' });
    await assignTask(slidesTask, speaker, 'complete');
    await assignTask(otherUploadTask, speaker, 'not_started');

    const res = await getDashboard(admin.cookie);
    const body = (await res.json()) as {
      tracking: { assets: Array<{ contact_id: string; missing_slides: number; missing_bio: number; missing_headshot: number }> };
    };
    const row = body.tracking.assets.find((a) => a.contact_id === speaker);
    // The other missing assets (bio/headshot are unset in this fixture) may
    // still list the speaker, but slides specifically must read as present.
    expect(row?.missing_slides).toBe(0);
  });

  it('still flags missing slides when no file_upload assignment is complete', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'noslides@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, submission, speaker).run();

    const slidesTask = await seedTask(eventId, { title: 'Presentation Upload', action_type: 'file_upload' });
    await assignTask(slidesTask, speaker, 'not_started');

    const res = await getDashboard(admin.cookie);
    const body = (await res.json()) as { tracking: { assets: Array<{ contact_id: string; missing_slides: number }> } };
    const row = body.tracking.assets.find((a) => a.contact_id === speaker);
    expect(row?.missing_slides).toBe(1);
  });

  // Eval defect: Priya's slides read as complete while the Tasks tab showed
  // four not_started rows and the event had Files=0. Slides completeness now
  // needs positive evidence (a completed upload task or an actual file) — a
  // speaker with only non-upload tasks and no files must be flagged.
  it('flags missing slides when the speaker has only non-upload tasks and no files on record', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'priya@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, submission, speaker).run();

    // Four tasks, all acknowledge-typed (the create form's default), all open.
    for (const title of ['Upload presentation', 'Confirm AV needs', 'Sign release', 'Book travel']) {
      const task = await seedTask(eventId, { title, action_type: 'acknowledge' });
      await assignTask(task, speaker, 'not_started');
    }

    const res = await getDashboard(admin.cookie);
    const body = (await res.json()) as { tracking: { assets: Array<{ contact_id: string; missing_slides: number }> } };
    const row = body.tracking.assets.find((a) => a.contact_id === speaker);
    expect(row?.missing_slides).toBe(1);
  });

  it('reads slides as present when a current uploaded file exists, even with no upload task', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'uploaded@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, submission, speaker).run();

    // A real deliverable in the same table the Files library reads.
    const requestId = await createFileRequest(eventId, { title: 'Slides' });
    const assetId = await seedFileAsset(eventId, speaker, { filename: 'slides.pdf' });
    await createFileRequestUpload(requestId, speaker, assetId);

    const res = await getDashboard(admin.cookie);
    const body = (await res.json()) as { tracking: { assets: Array<{ contact_id: string; missing_slides: number }> } };
    const row = body.tracking.assets.find((a) => a.contact_id === speaker);
    // The row may exist for missing bio/headshot, but slides must read present.
    expect(row?.missing_slides ?? 0).toBe(0);
  });
});

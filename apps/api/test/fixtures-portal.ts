// Lane-local seed helpers for the auth/portal/files tests (BE-2). Extends
// test/fixtures.ts (frozen) with the rows those three surfaces need: file
// assets that really exist in the KV store, submissions with participants,
// tasks/assignments, file requests and a minimal submission form.

import { env } from 'cloudflare:test';

const ts = '2026-08-01T00:00:00Z';

/** A PNG whose first bytes satisfy filestore's magic-number check. */
export function pngBytes(sizeBytes = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(16, sizeBytes));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/** A PDF whose first bytes satisfy filestore's magic-number check. */
export function pdfBytes(sizeBytes = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(16, sizeBytes));
  bytes.set(new TextEncoder().encode('%PDF-1.4'), 0);
  return bytes;
}

export function fileFrom(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}

/** file_assets row + the KV object, so loadFile actually returns bytes. */
export async function createFileAsset(
  eventId: string,
  overrides: Partial<{ id: string; uploadedBy: string | null; filename: string; contentType: string }> = {},
): Promise<string> {
  const id = overrides.id ?? `asset-${crypto.randomUUID()}`;
  const key = `file:${id}`;
  const contentType = overrides.contentType ?? 'image/png';
  const body = pngBytes();
  await env.KV.put(key, body as unknown as ArrayBuffer, {
    metadata: { content_type: contentType, filename: overrides.filename ?? 'headshot.png' },
  });
  await env.DB.prepare(
    `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, eventId, key, overrides.filename ?? 'headshot.png', contentType, body.byteLength, overrides.uploadedBy ?? null, ts)
    .run();
  return id;
}

// Profile columns (headshot, notes, ...) now live on event_contacts, keyed by
// (event_id, contact_id). Callers here only ever pass a contactId, so the
// event is derived from that contact's event_contacts row rather than
// widening every call site's signature; ORDER BY keeps it deterministic on
// the rare contact that already spans two events.
async function soleEventFor(contactId: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT event_id FROM event_contacts WHERE contact_id = ? ORDER BY added_at ASC LIMIT 1',
  ).bind(contactId).first<{ event_id: string }>();
  if (!row) throw new Error(`no event_contacts row for contact ${contactId}`);
  return row.event_id;
}

export async function setHeadshot(contactId: string, assetId: string): Promise<void> {
  const eventId = await soleEventFor(contactId);
  await env.DB.prepare('UPDATE event_contacts SET headshot_asset_id = ? WHERE event_id = ? AND contact_id = ?')
    .bind(assetId, eventId, contactId)
    .run();
}

export async function setEventLogo(eventId: string, assetId: string): Promise<void> {
  await env.DB.prepare('UPDATE events SET logo_asset_id = ? WHERE id = ?').bind(assetId, eventId).run();
}

export async function setContactNotes(contactId: string, notes: string): Promise<void> {
  const eventId = await soleEventFor(contactId);
  await env.DB.prepare('UPDATE event_contacts SET notes = ? WHERE event_id = ? AND contact_id = ?')
    .bind(notes, eventId, contactId)
    .run();
}

export async function createSubmissionForm(
  eventId: string,
  overrides: Partial<{
    id: string;
    notifyAdminsOnUpdate: string[];
    status: 'open' | 'closed';
    closeAt: string | null;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `form-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submission_forms (id, event_id, internal_name, status, close_at, notify_admins_on_update, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      eventId,
      'CFP',
      overrides.status ?? 'open',
      overrides.closeAt ?? null,
      overrides.notifyAdminsOnUpdate ? JSON.stringify(overrides.notifyAdminsOnUpdate) : null,
      ts,
      ts,
    )
    .run();
  return id;
}

/** One field_definitions + form_questions pair; returns the question id. */
export async function createQuestion(
  eventId: string,
  formId: string,
  opts: {
    key: string;
    label: string;
    type?: string;
    required?: boolean;
    position?: number;
    section?: 'abstract' | 'participant';
    maxChars?: number | null;
    options?: Array<{ value: string; label: string }> | null;
    /** Field-level audience (0042): 'internal' fields are organiser-only. */
    audience?: 'public' | 'internal';
    /** ConditionalRule json — show/hide this question based on an earlier one's answer. */
    visibility?: {
      action: 'show' | 'hide';
      match: 'all' | 'any';
      conditions: Array<{ question_id: string; op: string; value?: unknown }>;
    } | null;
  },
): Promise<string> {
  const fieldId = `fld-${crypto.randomUUID()}`;
  const questionId = `q-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, max_chars, system, audience)
     VALUES (?, ?, ?, ?, ?, 'submission', ?, ?, 1, ?)`,
  )
    .bind(fieldId, eventId, opts.key, opts.label, opts.type ?? 'text', opts.options ? JSON.stringify(opts.options) : null, opts.maxChars ?? null, opts.audience ?? 'public')
    .run();
  await env.DB.prepare(
    `INSERT INTO form_questions (id, form_id, section, field_id, label, position, required, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      questionId,
      formId,
      opts.section ?? 'abstract',
      fieldId,
      opts.label,
      opts.position ?? 0,
      opts.required ? 1 : 0,
      opts.visibility ? JSON.stringify(opts.visibility) : null,
    )
    .run();
  return questionId;
}

export async function createSubmission(
  eventId: string,
  overrides: Partial<{
    id: string; code: string; title: string; status: string;
    submitterContactId: string | null; formId: string | null; notes: string | null;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, form_id, code, title, status, submitter_contact_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      eventId,
      overrides.formId ?? null,
      overrides.code ?? `SESS-${Math.floor(Math.random() * 100000)}`,
      overrides.title ?? 'A talk about testing',
      overrides.status ?? 'pending',
      overrides.submitterContactId ?? null,
      overrides.notes ?? null,
      ts,
      ts,
    )
    .run();
  return id;
}

export async function addParticipant(submissionId: string, contactId: string, role = 'speaker'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, ?, 0, 1)`,
  )
    .bind(`sp-${crypto.randomUUID()}`, submissionId, contactId, role)
    .run();
}

export async function setAnswer(submissionId: string, questionId: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)',
  )
    .bind(submissionId, questionId, JSON.stringify(value))
    .run();
}

export async function createFileRequest(
  eventId: string,
  overrides: Partial<{ id: string; title: string; allowedTypes: string[] | null; maxSizeMb: number | null }> = {},
): Promise<string> {
  const id = overrides.id ?? `freq-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO file_requests (id, event_id, title, type, allowed_types, max_size_mb, created_at)
     VALUES (?, ?, ?, 'submissions', ?, ?, ?)`,
  )
    .bind(
      id,
      eventId,
      overrides.title ?? 'Upload slides',
      overrides.allowedTypes ? JSON.stringify(overrides.allowedTypes) : null,
      overrides.maxSizeMb ?? null,
      ts,
    )
    .run();
  return id;
}

/** A task plus one assignment for `contactId`; returns the assignment id. */
export async function createTaskAssignment(
  eventId: string,
  contactId: string,
  overrides: Partial<{
    actionType: 'file_upload' | 'portal_form' | 'acknowledge' | 'external_link';
    fileRequestId: string | null;
    portalFormId: string | null;
    submissionId: string | null;
    title: string;
  }> = {},
): Promise<string> {
  const taskId = `task-${crypto.randomUUID()}`;
  const assignmentId = `ta-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO tasks (id, event_id, title, action_type, portal_form_id, file_request_id, required, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      taskId,
      eventId,
      overrides.title ?? 'Upload your slides',
      overrides.actionType ?? 'file_upload',
      overrides.portalFormId ?? null,
      overrides.fileRequestId ?? null,
      ts,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO task_assignments (id, task_id, contact_id, submission_id, status) VALUES (?, ?, ?, ?, 'not_started')`,
  )
    .bind(assignmentId, taskId, contactId, overrides.submissionId ?? null)
    .run();
  return assignmentId;
}

export async function completeAssignmentWith(assignmentId: string, responseAssetId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE task_assignments SET status = 'complete', completed_at = ?, response_id = ? WHERE id = ?`,
  )
    .bind(ts, responseAssetId, assignmentId)
    .run();
}

export async function createFileRequestUpload(
  fileRequestId: string,
  contactId: string,
  assetId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  )
    .bind(`fru-${crypto.randomUUID()}`, fileRequestId, contactId, assetId, ts)
    .run();
}

/** An evaluation plan + a review assignment, so reviewer ACLs have a subject. */
export async function assignReviewer(
  eventId: string,
  submissionId: string,
  reviewerContactId: string,
): Promise<void> {
  const planId = `plan-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Plan', 'active', ?)`,
  )
    .bind(planId, eventId, ts)
    .run();
  await env.DB.prepare(
    `INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(`ra-${crypto.randomUUID()}`, planId, submissionId, reviewerContactId, ts)
    .run();
}

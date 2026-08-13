// Organiser-facing file surfaces (lane W2-C): the files library, the uploads
// attached to a submission, the version chain behind a task assignment, and the
// comment thread shared with the speaker portal.
//
// This lives in its own file (rather than adminApi.ts) and mounts at
// /app/api/files from app.ts, immediately after the /app/api mount so the
// shared admin guard still runs first. The guard is re-resolved defensively
// below so this router is correct even if the mount order ever changes.

import { Hono } from 'hono';
import { can } from '@kms/core';
import type { Actor } from '@kms/core';
import type { AccessEnv } from '../access';
import { accessibleEventIds } from '../access';
import { DOCUMENT_TYPES, IMAGE_TYPES, MAX_UPLOAD_BYTES, saveFile } from '../filestore';
import { bumpEventRevision } from '../revision';
import { getRevalidatedPrivilegedSession } from '../session';
import {
  addComment,
  appendUploadVersion,
  loadChainForUpload,
  loadChainVersions,
  loadThread,
  type FileCommentRow,
  type FileVersionRow,
} from '../fileVersions';

export const filesAdminRoutes = new Hono<AccessEnv>();

filesAdminRoutes.use('*', async (c, next) => {
  if (!c.get('session')) {
    const session = await getRevalidatedPrivilegedSession(c);
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
    if (!can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
    c.set('session', session);
  }
  await next();
});

/**
 * One row per *chain* (the current version), with the counts the library needs.
 * `version_count` and `comment_count` are correlated aggregates over the
 * indexed chain columns, and is_current makes "the file" a single row rather
 * than a MAX() over uploaded_at.
 *
 * `uploader_name`/`uploader_email` come from u.contact_id, which for the
 * original file-request flow (a speaker responding to a request themselves)
 * is always the same person who performed the upload. Headshots break that
 * assumption when set from the admin side (SPK-10): u.contact_id there is
 * the *subject* contact (the speaker the headshot is for), not necessarily
 * whoever clicked upload, so `uploaded_by_name`/`uploaded_by_email` are
 * added from fa.uploaded_by_contact_id — the actual uploader saveFile always
 * records — to keep "for" and "uploaded by" distinguishable in the UI.
 *
 * `session_id`/`session_code`/`session_title` (#9): u.submission_id is only
 * ever stamped when the task the upload came from was itself targeted at a
 * submission (target='submission') — a task assigned directly to a contact
 * can leave it NULL even when that contact has exactly one session, so a
 * library row for a plainly session-linked upload could otherwise show no
 * session at all. Falls back to the submission of *any* task_assignment for
 * the same (contact, chain) pair — the same file_request_id/contact_id
 * identity loadChainVersions keys a chain on — before giving up.
 */
const LIBRARY_SELECT = `SELECT u.id AS upload_id, u.file_asset_id, u.uploaded_at, u.version,
       u.submission_id, u.file_request_id, u.contact_id,
       fa.filename, fa.content_type, fa.size_bytes, fa.event_id,
       fr.title AS request_title,
       s.id AS session_id, s.code AS session_code, s.title AS session_title,
       s.code AS submission_code, s.title AS submission_title,
       NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS uploader_name,
       c.email AS uploader_email,
       NULLIF(TRIM(COALESCE(ub.first_name, '') || ' ' || COALESCE(ub.last_name, '')), '') AS uploaded_by_name,
       ub.email AS uploaded_by_email,
       (SELECT COUNT(*) FROM file_request_uploads p
         WHERE p.file_request_id = u.file_request_id AND p.contact_id = u.contact_id
           AND COALESCE(p.submission_id, '') = COALESCE(u.submission_id, '')) AS version_count,
       (SELECT COUNT(*) FROM file_comments fc
         JOIN file_request_uploads p2 ON p2.id = fc.file_request_upload_id
         WHERE p2.file_request_id = u.file_request_id AND p2.contact_id = u.contact_id
           AND COALESCE(p2.submission_id, '') = COALESCE(u.submission_id, '')) AS comment_count
FROM file_request_uploads u
JOIN file_assets fa ON fa.id = u.file_asset_id
LEFT JOIN file_requests fr ON fr.id = u.file_request_id
LEFT JOIN submissions s ON s.id = COALESCE(
  u.submission_id,
  (SELECT ta.submission_id FROM task_assignments ta JOIN tasks t2 ON t2.id = ta.task_id
    WHERE ta.contact_id = u.contact_id AND ta.submission_id IS NOT NULL
      AND (t2.file_request_id = u.file_request_id OR ('file-request-task-' || t2.id) = u.file_request_id)
    LIMIT 1)
)
LEFT JOIN contacts c ON c.id = u.contact_id
LEFT JOIN contacts ub ON ub.id = fa.uploaded_by_contact_id`;

/**
 * GET /app/api/files/library — the central files view, one row per chain.
 * Optional filters: submission_id, contact_id, q (filename/uploader), event_id.
 * Scoped to every event this staff email can reach, matching the workspace's
 * event-as-filter model.
 */
filesAdminRoutes.get('/library', async (c) => {
  const eventIds = await accessibleEventIds(c);
  const where: string[] = ['u.is_current = 1'];
  const params: unknown[] = [];

  const eventId = c.req.query('event_id');
  if (eventId) {
    if (!eventIds.includes(eventId)) return c.json({ error: 'forbidden' }, 403);
    where.push('fa.event_id = ?');
    params.push(eventId);
  } else {
    where.push(`fa.event_id IN (${eventIds.map(() => '?').join(', ')})`);
    params.push(...eventIds);
  }
  // Replay defect #11: a single chain by its current upload row's id, so the
  // admin SPA can resolve a `?rec=<upload_id>` deep link back to the row that
  // seeds the file detail tab (versions/comments) — files were the only
  // detail surface whose open state could not survive a URL navigation.
  const uploadId = c.req.query('upload_id');
  if (uploadId) {
    where.push('u.id = ?');
    params.push(uploadId);
  }
  const submissionId = c.req.query('submission_id');
  if (submissionId) {
    // #9: u.submission_id is stamped from task_assignments.submission_id at
    // upload time (portal.ts), which is only ever set when the task itself
    // was targeted at that submission — a task assigned directly to a
    // contact (expandTaskTargets' single-match fallback) can leave it NULL
    // even though the upload plainly belongs to that speaker's session. Also
    // match via the task-assignment chain identity (file_request_id +
    // contact_id, the same pair loadChainVersions keys a chain on) so a
    // session's Files section finds uploads made against any of that
    // session's tasks, not only the ones whose upload row got the
    // submission_id column stamped directly.
    where.push(`(u.submission_id = ? OR (
      u.submission_id IS NULL AND EXISTS (
        SELECT 1 FROM task_assignments ta
        JOIN tasks t2 ON t2.id = ta.task_id
        WHERE ta.contact_id = u.contact_id AND ta.submission_id = ?
          AND (t2.file_request_id = u.file_request_id OR ('file-request-task-' || t2.id) = u.file_request_id)
      )
    ))`);
    params.push(submissionId, submissionId);
  }
  const contactId = c.req.query('contact_id');
  if (contactId) {
    where.push('u.contact_id = ?');
    params.push(contactId);
  }
  const q = c.req.query('q');
  if (q) {
    // #9: session code/title are searchable too, so the library's free-text
    // box doubles as a session filter (the same resolved-session join
    // LIBRARY_SELECT uses, so a match here is exactly a match on what the
    // Session column displays).
    where.push('(fa.filename LIKE ? OR c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR s.code LIKE ? OR s.title LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  const size = Math.min(Math.max(Number(c.req.query('size') ?? 50) || 50, 1), 200);
  const from = Math.max(Number(c.req.query('from') ?? 0) || 0, 0);

  const clause = where.join(' AND ');
  const resolvedSessionJoin = `LEFT JOIN submissions s ON s.id = COALESCE(
      u.submission_id,
      (SELECT ta.submission_id FROM task_assignments ta JOIN tasks t3 ON t3.id = ta.task_id
        WHERE ta.contact_id = u.contact_id AND ta.submission_id IS NOT NULL
          AND (t3.file_request_id = u.file_request_id OR ('file-request-task-' || t3.id) = u.file_request_id)
        LIMIT 1)
    )`;
  const [list, count] = await Promise.all([
    c.env.DB.prepare(`${LIBRARY_SELECT} WHERE ${clause} ORDER BY u.uploaded_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, size, from)
      .all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM file_request_uploads u
       JOIN file_assets fa ON fa.id = u.file_asset_id
       LEFT JOIN contacts c ON c.id = u.contact_id
       ${q ? resolvedSessionJoin : ''}
       WHERE ${clause}`,
    )
      .bind(...params)
      .first<{ n: number }>(),
  ]);
  return c.json({ items: list.results, total: count?.n ?? 0 });
});

/** Chain + thread, once the chain has been proved to sit in an allowed event. */
async function chainPayload(
  db: D1Database,
  eventIds: string[],
  versions: FileVersionRow[],
): Promise<{ versions: FileVersionRow[]; comments: FileCommentRow[] } | null> {
  const first = versions[0];
  if (!first) return null;
  const scoped = await db
    .prepare(
      `SELECT 1 AS ok FROM file_assets
       WHERE id = ? AND event_id IN (${eventIds.map(() => '?').join(', ')})`,
    )
    .bind(first.file_asset_id, ...eventIds)
    .first<{ ok: number }>();
  if (!scoped) return null;
  return { versions, comments: await loadThread(db, versions) };
}

// GET /app/api/files/chains/:uploadId — every version + the whole thread.
filesAdminRoutes.get('/chains/:uploadId', async (c) => {
  const eventIds = await accessibleEventIds(c);
  const versions = await loadChainForUpload(c.env.DB, c.req.param('uploadId'));
  const payload = await chainPayload(c.env.DB, eventIds, versions);
  if (!payload) return c.json({ error: 'not_found' }, 404);
  return c.json(payload);
});

/**
 * GET /app/api/files/task-assignments/:id — what the Tasks tab needs: the file
 * a completed file_upload task produced. Assignments backed by a file request
 * resolve to the full chain; a bare file_upload task (no request row) has only
 * task_assignments.response_id, so that single asset is returned instead —
 * either way the organiser gets a /files/:id link where there was none.
 */
filesAdminRoutes.get('/task-assignments/:id', async (c) => {
  const eventIds = await accessibleEventIds(c);
  const row = await c.env.DB.prepare(
    `SELECT ta.id, ta.task_id, ta.contact_id, ta.submission_id, ta.response_id, ta.status,
            t.file_request_id, t.action_type, t.event_id
     FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
     WHERE ta.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{
      id: string;
      task_id: string;
      contact_id: string;
      submission_id: string | null;
      response_id: string | null;
      status: string;
      file_request_id: string | null;
      action_type: string;
      event_id: string;
    }>();
  if (!row || !eventIds.includes(row.event_id)) return c.json({ error: 'not_found' }, 404);
  if (row.action_type !== 'file_upload') return c.json({ versions: [], comments: [] });

  // A task with no file_requests row still gets a standing per-task request
  // (`file-request-task-<taskId>`, created by the portal on first upload) so
  // its uploads land in the library — read that chain the same way.
  const chainRequestId = row.file_request_id ?? `file-request-task-${row.task_id}`;
  {
    const versions = await loadChainVersions(c.env.DB, {
      fileRequestId: chainRequestId,
      contactId: row.contact_id,
      submissionId: row.submission_id,
    });
    if (versions.length > 0) {
      return c.json({ versions, comments: await loadThread(c.env.DB, versions) });
    }
  }
  if (!row.response_id) return c.json({ versions: [], comments: [] });
  const asset = await c.env.DB.prepare(
    'SELECT id, filename, content_type, size_bytes, created_at FROM file_assets WHERE id = ? AND event_id = ?',
  )
    .bind(row.response_id, row.event_id)
    .first<{
      id: string;
      filename: string;
      content_type: string | null;
      size_bytes: number | null;
      created_at: string;
    }>();
  if (!asset) return c.json({ versions: [], comments: [] });
  // Shaped like a chain of one so the UI has a single rendering path. There is
  // no upload row to hang comments on, which the empty upload_id signals.
  const only: FileVersionRow = {
    upload_id: '',
    file_request_id: '',
    contact_id: row.contact_id,
    submission_id: row.submission_id,
    file_asset_id: asset.id,
    uploaded_at: asset.created_at,
    version: 1,
    is_current: 1,
    filename: asset.filename,
    content_type: asset.content_type,
    size_bytes: asset.size_bytes,
    uploader_name: null,
    uploader_email: null,
    uploaded_by_name: null,
    uploaded_by_email: null,
  };
  return c.json({ versions: [only], comments: [] });
});

/**
 * GET /app/api/files/submissions/:submissionId/comments — every deck comment
 * on this submission, across every chain and every version, oldest first.
 *
 * Workplan 15 W5d: the detail panel renders these directly beneath the
 * submission_comments thread so "the review comments sit next to the review
 * comments that got it accepted". No schema change was needed — file_comments
 * already carries author, role and denormalised name, and is version-anchored
 * (0007), which is why the version label stays correct after a v2 lands rather
 * than re-pointing at the newest file.
 */
filesAdminRoutes.get('/submissions/:submissionId/comments', async (c) => {
  const eventIds = await accessibleEventIds(c);
  const { results } = await c.env.DB.prepare(
    `SELECT fc.id, fc.file_request_upload_id, fc.author_role, fc.author_name, fc.body, fc.created_at,
            u.version, fa.filename
     FROM file_comments fc
     JOIN file_request_uploads u ON u.id = fc.file_request_upload_id
     JOIN file_assets fa ON fa.id = u.file_asset_id
     WHERE u.submission_id = ? AND fa.event_id IN (${eventIds.map(() => '?').join(', ')})
     ORDER BY fc.created_at, fc.id`,
  )
    .bind(c.req.param('submissionId'), ...eventIds)
    .all();
  return c.json({ items: results });
});

/** Portal-parity accepted types for organiser uploads: documents + images. */
const ORGANISER_UPLOAD_TYPES = new Set<string>([...DOCUMENT_TYPES, ...IMAGE_TYPES]);

/**
 * POST /app/api/files/uploads — organiser-side upload (eval defect: the
 * submission Files section offered only "No files uploaded" text, so an
 * organiser could not add or replace a deliverable on a speaker's behalf).
 *
 * Multipart form fields:
 *  - `file`          the bytes (required)
 *  - `upload_id`     an existing chain: the new file becomes its next version
 *  - `submission_id` a new chain on this submission (used when no upload_id)
 *
 * Reuses the exact machinery the portal uses (saveFile + appendUploadVersion),
 * so an organiser upload is indistinguishable from a speaker upload in the
 * library, the version chain and the /files/:id ACL. New chains hang off a
 * standing per-event "Organiser uploads" file request, mirroring the
 * headshot/per-task standing requests.
 */
filesAdminRoutes.post('/uploads', async (c) => {
  const session = c.get('session');
  if (session.role !== 'owner' && session.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const eventIds = await accessibleEventIds(c);

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'file_required' }, 400);
  const uploadId = typeof body.upload_id === 'string' ? body.upload_id : '';
  const submissionId = typeof body.submission_id === 'string' ? body.submission_id : '';

  let key: { fileRequestId: string; contactId: string; submissionId: string | null };
  let eventId: string;

  if (uploadId) {
    // New version of an existing chain.
    const anchor = await c.env.DB.prepare(
      `SELECT u.file_request_id, u.contact_id, u.submission_id, fa.event_id
       FROM file_request_uploads u JOIN file_assets fa ON fa.id = u.file_asset_id
       WHERE u.id = ?`,
    )
      .bind(uploadId)
      .first<{ file_request_id: string; contact_id: string; submission_id: string | null; event_id: string }>();
    if (!anchor || !eventIds.includes(anchor.event_id)) return c.json({ error: 'not_found' }, 404);
    eventId = anchor.event_id;
    key = {
      fileRequestId: anchor.file_request_id,
      contactId: anchor.contact_id,
      submissionId: anchor.submission_id,
    };
  } else {
    // New chain on a submission. The chain's contact is the speaker the file
    // is for — the submission's submitter (or first participant) — so the
    // library's "For" semantics hold; file_assets.uploaded_by_contact_id
    // separately records the organiser who performed the upload.
    if (!submissionId) return c.json({ error: 'submission_id_required' }, 400);
    const submission = await c.env.DB.prepare(
      `SELECT s.id, s.event_id, s.submitter_contact_id,
              (SELECT sp.contact_id FROM submission_participants sp
                WHERE sp.submission_id = s.id ORDER BY sp.position LIMIT 1) AS participant_contact_id
       FROM submissions s WHERE s.id = ?`,
    )
      .bind(submissionId)
      .first<{
        id: string;
        event_id: string;
        submitter_contact_id: string | null;
        participant_contact_id: string | null;
      }>();
    if (!submission || !eventIds.includes(submission.event_id)) return c.json({ error: 'not_found' }, 404);
    eventId = submission.event_id;
    const contactId =
      submission.submitter_contact_id ?? submission.participant_contact_id ?? session.contactId;
    const fileRequestId = `file-request-organiser-${eventId}`;
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO file_requests (id, event_id, title, type, created_at)
       VALUES (?, ?, 'Organiser uploads', 'submissions', ?)`,
    )
      .bind(fileRequestId, eventId, new Date().toISOString())
      .run();
    key = { fileRequestId, contactId, submissionId };
  }

  const saved = await saveFile(c.env, {
    eventId,
    uploadedByContactId: session.contactId,
    file,
    maxBytes: MAX_UPLOAD_BYTES,
    allowedTypes: ORGANISER_UPLOAD_TYPES,
  });
  if ('error' in saved) return c.json({ error: saved.error }, 400);

  const appended = await appendUploadVersion(c.env.DB, key, {
    assetId: saved.id,
    uploadedAt: new Date().toISOString(),
  });
  await bumpEventRevision(c.env, eventId);
  const versions = await loadChainVersions(c.env.DB, key);
  return c.json(
    { ok: true, upload_id: appended.uploadId, version: appended.version, versions },
    201,
  );
});

// POST /app/api/files/uploads/:uploadId/comments { body } — an organiser reply
// on the same thread the speaker sees. Reviewers are read-only here.
filesAdminRoutes.post('/uploads/:uploadId/comments', async (c) => {
  const session = c.get('session');
  const eventIds = await accessibleEventIds(c);
  const uploadId = c.req.param('uploadId');
  const upload = await c.env.DB.prepare(
    `SELECT u.id, u.file_asset_id, fa.event_id
     FROM file_request_uploads u JOIN file_assets fa ON fa.id = u.file_asset_id
     WHERE u.id = ?`,
  )
    .bind(uploadId)
    .first<{ id: string; file_asset_id: string; event_id: string }>();
  if (!upload || !eventIds.includes(upload.event_id)) return c.json({ error: 'not_found' }, 404);
  if (session.role !== 'owner' && session.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof body.body === 'string' ? body.body : '';
  const author = await c.env.DB.prepare(
    `SELECT NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') AS name, email
     FROM contacts WHERE id = ?`,
  )
    .bind(session.contactId)
    .first<{ name: string | null; email: string }>();
  const id = await addComment(c.env.DB, {
    eventId: upload.event_id,
    uploadId: upload.id,
    assetId: upload.file_asset_id,
    authorContactId: session.contactId,
    authorRole: session.role,
    authorName: author?.name ?? author?.email ?? session.email,
    body: text,
  });
  if (!id) return c.json({ error: 'empty_body' }, 400);
  const versions = await loadChainForUpload(c.env.DB, upload.id);
  return c.json({ ok: true, id, comments: await loadThread(c.env.DB, versions) });
});

// ---------------------------------------------------------------------------
// #18: event-level file-collection defaults — a modest per-event setting so
// an organiser doesn't have to configure "Action type = File upload" and its
// allowed types from scratch on every task. Two columns on `events`
// (0040_event_file_defaults.sql), following the same small-dedicated-route
// pattern as chase.ts's GET/PUT /app/api/chase/settings, rather than folding
// into the generic PATCH /events form (adminApi.ts's pickEventFields) —
// `default_file_upload_enabled` and `default_file_allowed_types` are a
// task-creation nicety, not settings-history content.
// ---------------------------------------------------------------------------

interface FileDefaultsRow {
  default_file_upload_enabled: number;
  default_file_allowed_types: string | null;
}

/** GET /app/api/files/settings — the current event's file-collection defaults. */
filesAdminRoutes.get('/settings', async (c) => {
  const session = c.get('session');
  const row = await c.env.DB.prepare(
    'SELECT default_file_upload_enabled, default_file_allowed_types FROM events WHERE id = ?',
  )
    .bind(session.eventId)
    .first<FileDefaultsRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({
    enabled: row.default_file_upload_enabled === 1,
    allowed_types: row.default_file_allowed_types ? (JSON.parse(row.default_file_allowed_types) as string[]) : [],
  });
});

/** PUT /app/api/files/settings { enabled, allowed_types } */
filesAdminRoutes.put('/settings', async (c) => {
  const session = c.get('session');
  if (session.role !== 'owner' && session.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const enabled = body.enabled === true;
  const allowedTypes = Array.isArray(body.allowed_types)
    ? body.allowed_types.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : [];

  await c.env.DB.prepare(
    'UPDATE events SET default_file_upload_enabled = ?, default_file_allowed_types = ?, updated_at = ? WHERE id = ?',
  )
    .bind(enabled ? 1 : 0, allowedTypes.length > 0 ? JSON.stringify(allowedTypes) : null, new Date().toISOString(), session.eventId)
    .run();
  return c.json({ ok: true, enabled, allowed_types: allowedTypes });
});

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
import { getRevalidatedPrivilegedSession } from '../session';
import {
  addComment,
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
 */
const LIBRARY_SELECT = `SELECT u.id AS upload_id, u.file_asset_id, u.uploaded_at, u.version,
       u.submission_id, u.file_request_id, u.contact_id,
       fa.filename, fa.content_type, fa.size_bytes, fa.event_id,
       fr.title AS request_title,
       s.code AS submission_code, s.title AS submission_title,
       NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS uploader_name,
       c.email AS uploader_email,
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
LEFT JOIN submissions s ON s.id = u.submission_id
LEFT JOIN contacts c ON c.id = u.contact_id`;

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
  const submissionId = c.req.query('submission_id');
  if (submissionId) {
    where.push('u.submission_id = ?');
    params.push(submissionId);
  }
  const contactId = c.req.query('contact_id');
  if (contactId) {
    where.push('u.contact_id = ?');
    params.push(contactId);
  }
  const q = c.req.query('q');
  if (q) {
    where.push('(fa.filename LIKE ? OR c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const size = Math.min(Math.max(Number(c.req.query('size') ?? 50) || 50, 1), 200);
  const from = Math.max(Number(c.req.query('from') ?? 0) || 0, 0);

  const clause = where.join(' AND ');
  const [list, count] = await Promise.all([
    c.env.DB.prepare(`${LIBRARY_SELECT} WHERE ${clause} ORDER BY u.uploaded_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, size, from)
      .all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM file_request_uploads u
       JOIN file_assets fa ON fa.id = u.file_asset_id
       LEFT JOIN contacts c ON c.id = u.contact_id
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
    `SELECT ta.id, ta.contact_id, ta.submission_id, ta.response_id, ta.status,
            t.file_request_id, t.action_type, t.event_id
     FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
     WHERE ta.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{
      id: string;
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

  if (row.file_request_id) {
    const versions = await loadChainVersions(c.env.DB, {
      fileRequestId: row.file_request_id,
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
  };
  return c.json({ versions: [only], comments: [] });
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

// Version chains and comment threads for file-request uploads (lane W2-C).
//
// One *chain* is the (file_request_id, contact_id, submission_id) triple: the
// same speaker answering the same request for the same submission. Every
// upload appends a row to file_request_uploads; migration 0007 stamps each one
// with `version` (1-based ordinal) and `is_current`, so the "latest" file is a
// column lookup rather than a MAX() over uploaded_at in every caller.
//
// Both sides of the app read through here: the speaker portal (routes/portal.ts)
// and the organiser API (routes/filesAdmin.ts) must show the same list and the
// same thread, so the queries live in one place.

export interface ChainKey {
  fileRequestId: string;
  contactId: string;
  submissionId: string | null;
}

export interface FileVersionRow {
  upload_id: string;
  file_request_id: string;
  contact_id: string;
  submission_id: string | null;
  file_asset_id: string;
  uploaded_at: string;
  version: number;
  is_current: number;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  uploader_name: string | null;
  uploader_email: string | null;
  /**
   * Who actually performed the upload (file_assets.uploaded_by_contact_id) —
   * distinct from uploader_name/email, which describe the chain's contact
   * (the speaker the file is *for*; an admin-side headshot or organiser
   * upload is performed by someone else). UIs should prefer these for
   * "Uploaded by" and fall back to the chain contact.
   */
  uploaded_by_name: string | null;
  uploaded_by_email: string | null;
}

export interface FileCommentRow {
  id: string;
  file_request_upload_id: string;
  file_asset_id: string;
  author_contact_id: string | null;
  author_role: string;
  author_name: string | null;
  body: string;
  created_at: string;
  /** version ordinal of the upload the comment was left on */
  version: number;
}

const VERSION_SELECT = `SELECT u.id AS upload_id, u.file_request_id, u.contact_id, u.submission_id,
       u.file_asset_id, u.uploaded_at, u.version, u.is_current,
       fa.filename, fa.content_type, fa.size_bytes,
       NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS uploader_name,
       c.email AS uploader_email,
       NULLIF(TRIM(COALESCE(ub.first_name, '') || ' ' || COALESCE(ub.last_name, '')), '') AS uploaded_by_name,
       ub.email AS uploaded_by_email
FROM file_request_uploads u
JOIN file_assets fa ON fa.id = u.file_asset_id
LEFT JOIN contacts c ON c.id = u.contact_id
LEFT JOIN contacts ub ON ub.id = fa.uploaded_by_contact_id`;

/** Every version in one chain, oldest first. */
export async function loadChainVersions(db: D1Database, key: ChainKey): Promise<FileVersionRow[]> {
  const { results } = await db
    .prepare(
      `${VERSION_SELECT}
       WHERE u.file_request_id = ? AND u.contact_id = ?
         AND COALESCE(u.submission_id, '') = COALESCE(?, '')
       ORDER BY u.version`,
    )
    .bind(key.fileRequestId, key.contactId, key.submissionId)
    .all<FileVersionRow>();
  return results;
}

/** Every version of the chain a single upload row belongs to, oldest first. */
export async function loadChainForUpload(db: D1Database, uploadId: string): Promise<FileVersionRow[]> {
  const anchor = await db
    .prepare('SELECT file_request_id, contact_id, submission_id FROM file_request_uploads WHERE id = ?')
    .bind(uploadId)
    .first<{ file_request_id: string; contact_id: string; submission_id: string | null }>();
  if (!anchor) return [];
  return loadChainVersions(db, {
    fileRequestId: anchor.file_request_id,
    contactId: anchor.contact_id,
    submissionId: anchor.submission_id,
  });
}

/**
 * Append a new version to a chain: the previous current row is demoted in the
 * same batch that inserts the new one, so no window exists where a chain has
 * two current rows (or none).
 */
export async function appendUploadVersion(
  db: D1Database,
  key: ChainKey,
  opts: { assetId: string; uploadedAt: string },
): Promise<{ uploadId: string; version: number }> {
  const prev = await db
    .prepare(
      `SELECT MAX(version) AS v FROM file_request_uploads
       WHERE file_request_id = ? AND contact_id = ? AND COALESCE(submission_id, '') = COALESCE(?, '')`,
    )
    .bind(key.fileRequestId, key.contactId, key.submissionId)
    .first<{ v: number | null }>();
  const version = (prev?.v ?? 0) + 1;
  const uploadId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `UPDATE file_request_uploads SET is_current = 0
         WHERE file_request_id = ? AND contact_id = ? AND COALESCE(submission_id, '') = COALESCE(?, '')`,
      )
      .bind(key.fileRequestId, key.contactId, key.submissionId),
    db
      .prepare(
        `INSERT INTO file_request_uploads
           (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at, version, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(uploadId, key.fileRequestId, key.contactId, key.submissionId, opts.assetId, opts.uploadedAt, version),
  ]);
  return { uploadId, version };
}

/**
 * The comment thread for a chain. Comments are anchored to the version they
 * were written against (so "slide 12 is unreadable" keeps pointing at the deck
 * it described), but the thread is the union across the chain in time order —
 * a v1 comment stays visible and replyable after v2 lands.
 */
export async function loadThread(db: D1Database, versions: FileVersionRow[]): Promise<FileCommentRow[]> {
  if (versions.length === 0) return [];
  const ids = versions.map((v) => v.upload_id);
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT fc.id, fc.file_request_upload_id, fc.file_asset_id, fc.author_contact_id,
              fc.author_role, fc.author_name, fc.body, fc.created_at, u.version
       FROM file_comments fc
       JOIN file_request_uploads u ON u.id = fc.file_request_upload_id
       WHERE fc.file_request_upload_id IN (${placeholders})
       ORDER BY fc.created_at, fc.id`,
    )
    .bind(...ids)
    .all<FileCommentRow>();
  return results;
}

export const MAX_COMMENT_CHARS = 2000;

/**
 * Add a comment to one version. Returns null when the body is empty after
 * trimming; callers surface that as a field error rather than a 500.
 */
export async function addComment(
  db: D1Database,
  opts: {
    eventId: string;
    uploadId: string;
    assetId: string;
    authorContactId: string;
    authorRole: string;
    authorName: string | null;
    body: string;
  },
): Promise<string | null> {
  const body = opts.body.trim().slice(0, MAX_COMMENT_CHARS);
  if (body === '') return null;
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO file_comments
         (id, event_id, file_request_upload_id, file_asset_id, author_contact_id, author_role, author_name, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.eventId,
      opts.uploadId,
      opts.assetId,
      opts.authorContactId,
      opts.authorRole,
      opts.authorName,
      body,
      new Date().toISOString(),
    )
    .run();
  return id;
}

/** Human-readable size for both UIs; keeps the two sides consistent. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

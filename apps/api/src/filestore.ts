// File storage seam. Judgment call (documented in docs/12 M2 notes): the R2
// binding stays off until the account carries the R2 subscription, so bytes
// live in KV (25 MB value cap, far above our per-file limits) with metadata
// in D1 file_assets. The seam is this module — an R2 implementation swaps in
// behind saveFile/loadFile without touching any caller.

import type { Env } from './env';

export const MAX_HEADSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'image/jpeg',
  'image/png',
]);

export interface SavedFile {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface FileAssetRow {
  id: string;
  event_id: string;
  key: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
}

export async function saveFile(
  env: Env,
  opts: {
    eventId: string;
    uploadedByContactId: string | null;
    file: File;
    maxBytes: number;
    allowedTypes: Set<string>;
  },
): Promise<SavedFile | { error: string }> {
  if (opts.file.size === 0) return { error: 'empty_file' };
  if (opts.file.size > opts.maxBytes) {
    return { error: `File is too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB).` };
  }
  const contentType = opts.file.type || 'application/octet-stream';
  if (!opts.allowedTypes.has(contentType)) {
    return { error: `File type ${contentType} is not accepted.` };
  }

  const id = crypto.randomUUID();
  const key = `file:${id}`;
  await env.KV.put(key, await opts.file.arrayBuffer(), {
    metadata: { content_type: contentType, filename: opts.file.name },
  });
  await env.DB.prepare(
    `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, opts.eventId, key, opts.file.name, contentType, opts.file.size, opts.uploadedByContactId, new Date().toISOString())
    .run();
  return { id, filename: opts.file.name, content_type: contentType, size_bytes: opts.file.size };
}

export async function loadFile(
  env: Env,
  id: string,
): Promise<{ row: FileAssetRow; body: ArrayBuffer } | null> {
  const row = await env.DB.prepare('SELECT * FROM file_assets WHERE id = ?').bind(id).first<FileAssetRow>();
  if (!row) return null;
  const body = await env.KV.get(row.key, 'arrayBuffer');
  if (!body) return null;
  return { row, body };
}

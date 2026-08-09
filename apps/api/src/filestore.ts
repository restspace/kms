// File storage seam. Judgment call (documented in docs/12 M2 notes): the R2
// binding stays off until the account carries the R2 subscription, so bytes
// live in KV (25 MB value cap, far above our per-file limits) with metadata
// in D1 file_assets. The seam is this module — an R2 implementation swaps in
// behind saveFile/loadFile without touching any caller.

import type { Env } from './env';

export const MAX_HEADSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
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

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function matchesDeclaredType(contentType: string, bytes: Uint8Array): boolean {
  const jpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
  const png = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  const pdf = String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
  const ole = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  switch (contentType) {
    case 'image/jpeg': return jpeg;
    case 'image/png': return png;
    case 'image/webp': return webp;
    case 'application/pdf': return pdf;
    case 'application/zip':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return zip;
    case 'application/vnd.ms-powerpoint':
    case 'application/msword':
      return ole;
    default:
      return false;
  }
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
  const body = await opts.file.arrayBuffer();
  if (!matchesDeclaredType(contentType, new Uint8Array(body, 0, Math.min(body.byteLength, 16)))) {
    return { error: 'File contents do not match the declared file type.' };
  }

  const id = crypto.randomUUID();
  const key = `file:${id}`;
  await env.KV.put(key, body, {
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
  eventId: string,
): Promise<{ row: FileAssetRow; body: ArrayBuffer } | null> {
  // Scope metadata before touching the object store. Wrong-tenant probes
  // should be cheap and must not load another event's bytes into memory.
  const row = await env.DB.prepare('SELECT * FROM file_assets WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first<FileAssetRow>();
  if (!row) return null;
  const body = await env.KV.get(row.key, 'arrayBuffer');
  if (!body) return null;
  return { row, body };
}

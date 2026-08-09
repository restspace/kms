// FR-REV-8 — spreadsheet import + files bundle (docs/06 §6).
//
// Two routers out of one file because they mount at two different prefixes:
//   /app/api/import/*  — upload → column mapping → dry run → commit
//   /app/api/export/*  — ZIP of the current version of selected files
// Both are registered *after* the /app/api mount in app.ts, so adminApi's
// `use('*')` guard has already populated `session`; it is re-resolved here
// defensively so the routers stay correct if the mount order ever changes.
//
// The import is deliberately stateless between preview and commit: the
// preview response carries the parsed grid back to the browser, and the commit
// posts (headers, rows, mapping) again. That means no server-side scratch
// storage and no expiring upload handle — and the commit *re-plans* rather
// than trusting the actions the preview rendered, so a tampered payload cannot
// turn a "skip" into an overwrite.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { zipSync } from 'fflate';
import { can } from '@kms/core';
import type { Actor } from '@kms/core';
import type { AccessEnv } from '../access';
import { accessibleEventIds, isWriter, requireEventAccess } from '../access';
import { getRevalidatedPrivilegedSession } from '../session';
import { bumpEventRevision } from '../revision';
import {
  ImportParseError,
  TARGET_FIELDS,
  autoMap,
  commitStatements,
  isImportTarget,
  parseUpload,
  planImport,
  type ImportTarget,
} from '../importer';

export const importRoutes = new Hono<AccessEnv>();
export const exportRoutes = new Hono<AccessEnv>();

/** Rows above this are refused outright rather than half-imported. */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** ZIP guard rails — the bundle is built in memory inside the Worker. */
export const MAX_BUNDLE_FILES = 250;
export const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;

const guard: MiddlewareHandler<AccessEnv> = async (c, next) => {
  if (!c.get('session')) {
    const session = await getRevalidatedPrivilegedSession(c);
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
    if (!can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
    c.set('session', session);
  }
  await next();
};

importRoutes.use('*', guard);
exportRoutes.use('*', guard);

/**
 * An import always writes into exactly one event. The workspace's "All events"
 * filter has no target, so the client must name one — the UI disables the
 * Import button in that mode and this is the server-side half of the same rule.
 */
async function targetEvent(
  c: Context<AccessEnv>,
  eventId: unknown,
): Promise<{ eventId: string } | { error: string; status: 400 | 403 }> {
  const session = c.get('session');
  if (!isWriter(session.role)) return { error: 'forbidden', status: 403 };
  const id = typeof eventId === 'string' && eventId ? eventId : '';
  if (!id) return { error: 'event_required', status: 400 };
  const seat = await requireEventAccess(c, id);
  if (!seat && id !== session.eventId) return { error: 'forbidden', status: 403 };
  if (!isWriter(seat?.role ?? session.role)) return { error: 'forbidden', status: 403 };
  return { eventId: id };
}

/** GET /app/api/import/fields?target=sessions — the mapping step's catalogue. */
importRoutes.get('/fields', (c) => {
  const target = c.req.query('target');
  if (!isImportTarget(target)) return c.json({ error: 'unknown_target' }, 400);
  return c.json({ target, fields: TARGET_FIELDS[target] });
});

const asGrid = (value: unknown): string[][] =>
  Array.isArray(value)
    ? value.map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))) : []))
    : [];

/**
 * POST /app/api/import/preview
 *  - multipart/form-data { file, target, event_id, mapping? } for the first
 *    pass (parse + auto-map + dry run), or
 *  - application/json { target, event_id, headers, rows, mapping } to re-run
 *    the dry run after the organiser edits the mapping — no re-upload.
 */
importRoutes.post('/preview', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let target: unknown;
  let eventId: unknown;
  let headers: string[] = [];
  let rows: string[][] = [];
  let mapping: string[] | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    target = form.get('target');
    eventId = form.get('event_id');
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
    if (file.size === 0) return c.json({ error: 'empty_file' }, 400);
    if (file.size > MAX_IMPORT_BYTES) return c.json({ error: 'file_too_large' }, 400);
    const raw = form.get('mapping');
    if (typeof raw === 'string' && raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) mapping = parsed.map((v) => (typeof v === 'string' ? v : ''));
      } catch {
        return c.json({ error: 'invalid_mapping' }, 400);
      }
    }
    let grid: string[][];
    try {
      grid = parseUpload(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      return c.json({ error: err instanceof ImportParseError ? err.code : 'unreadable_file' }, 400);
    }
    headers = (grid[0] ?? []).map((h) => h.trim());
    rows = grid.slice(1);
  } else {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    target = body.target;
    eventId = body.event_id;
    headers = Array.isArray(body.headers) ? body.headers.map((h) => String(h ?? '').trim()) : [];
    rows = asGrid(body.rows);
    if (Array.isArray(body.mapping)) mapping = body.mapping.map((v) => (typeof v === 'string' ? v : ''));
  }

  if (!isImportTarget(target)) return c.json({ error: 'unknown_target' }, 400);
  const scope = await targetEvent(c, eventId);
  if ('error' in scope) return c.json({ error: scope.error }, scope.status);
  if (headers.length === 0) return c.json({ error: 'no_header_row' }, 400);
  if (rows.length === 0) return c.json({ error: 'no_data_rows' }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: 'too_many_rows', limit: MAX_IMPORT_ROWS }, 400);

  const resolved = normaliseMapping(mapping, headers, target);
  const plan = await planImport({ db: c.env.DB, eventId: scope.eventId }, target, headers, rows, resolved);
  return c.json({ ...plan, event_id: scope.eventId, rows_raw: rows, fields: TARGET_FIELDS[target] });
});

/** User mapping wins where it is valid; anything else is auto-mapped. */
function normaliseMapping(mapping: string[] | null, headers: string[], target: ImportTarget): string[] {
  if (!mapping) return autoMap(headers, target);
  const known = new Set(TARGET_FIELDS[target].map((f) => f.key));
  const used = new Set<string>();
  return headers.map((_h, i) => {
    const key = mapping[i] ?? '';
    if (!known.has(key) || used.has(key)) return '';
    used.add(key);
    return key;
  });
}

/**
 * POST /app/api/import/commit { target, event_id, headers, rows, mapping }
 * Re-plans, then applies the whole plan in a single `db.batch()` — D1 wraps a
 * batch in one implicit transaction, so a failure part-way leaves nothing
 * behind (the "atomic-ish" bar the submission pipeline already holds itself to).
 */
importRoutes.post('/commit', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const target = body.target;
  if (!isImportTarget(target)) return c.json({ error: 'unknown_target' }, 400);
  const scope = await targetEvent(c, body.event_id);
  if ('error' in scope) return c.json({ error: scope.error }, scope.status);

  const headers = Array.isArray(body.headers) ? body.headers.map((h) => String(h ?? '').trim()) : [];
  const rows = asGrid(body.rows);
  if (headers.length === 0) return c.json({ error: 'no_header_row' }, 400);
  if (rows.length === 0) return c.json({ error: 'no_data_rows' }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: 'too_many_rows', limit: MAX_IMPORT_ROWS }, 400);

  const mapping = normaliseMapping(
    Array.isArray(body.mapping) ? body.mapping.map((v) => (typeof v === 'string' ? v : '')) : null,
    headers,
    target,
  );
  const plan = await planImport({ db: c.env.DB, eventId: scope.eventId }, target, headers, rows, mapping);
  const { statements, applied } = commitStatements(c.env.DB, scope.eventId, plan);
  if (statements.length > 0) {
    try {
      await c.env.DB.batch(statements);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'import_failed', detail }, 409);
    }
    await bumpEventRevision(c.env, scope.eventId);
  }
  return c.json({ ok: true, target, event_id: scope.eventId, summary: plan.summary, applied, plan_rows: plan.rows });
});

// ---------------------------------------------------------------------------
// Files bundle
// ---------------------------------------------------------------------------

/** `<code>-<title>` per docs/06 §6, made safe for every desktop unzip tool. */
export function bundleFolder(code: string | null, title: string | null): string {
  const slug = (title ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const parts = [code ?? '', slug].filter(Boolean);
  return parts.join('-') || 'submission';
}

const safeName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_');

/** "deck.pdf" twice in one folder becomes "deck.pdf" and "deck (2).pdf". */
export function uniqueEntry(taken: Set<string>, path: string): string {
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot > path.lastIndexOf('/') + 1 ? path.slice(0, dot) : path;
  const ext = stem === path ? '' : path.slice(dot);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * POST /app/api/export/files.zip { submission_ids: [...] }
 * The *current* version of every upload attached to the selected submissions —
 * `is_current = 1` is the whole version filter, so a deck that has been
 * re-uploaded three times contributes one entry, not three. POST rather than
 * GET because a grid selection is unbounded; the browser turns the response
 * into a download via a blob URL.
 */
exportRoutes.post('/files.zip', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(body.submission_ids)
    ? [...new Set(body.submission_ids.filter((v): v is string => typeof v === 'string' && v !== ''))]
    : [];
  if (ids.length === 0) return c.json({ error: 'no_submissions' }, 400);

  const eventIds = await accessibleEventIds(c);
  const { results } = await c.env.DB.prepare(
    `SELECT u.submission_id, u.uploaded_at, s.code, s.title, fa.key, fa.filename, fa.size_bytes
     FROM file_request_uploads u
     JOIN file_assets fa ON fa.id = u.file_asset_id
     JOIN submissions s ON s.id = u.submission_id
     WHERE u.is_current = 1
       AND u.submission_id IN (${ids.map(() => '?').join(', ')})
       AND s.event_id IN (${eventIds.map(() => '?').join(', ')})
     ORDER BY s.code, u.uploaded_at`,
  )
    .bind(...ids, ...eventIds)
    .all<{
      submission_id: string;
      uploaded_at: string;
      code: string | null;
      title: string | null;
      key: string;
      filename: string;
      size_bytes: number | null;
    }>();

  if (results.length === 0) return c.json({ error: 'no_files' }, 404);
  if (results.length > MAX_BUNDLE_FILES) return c.json({ error: 'bundle_too_large', limit: MAX_BUNDLE_FILES }, 413);
  const declared = results.reduce((sum, r) => sum + (r.size_bytes ?? 0), 0);
  if (declared > MAX_BUNDLE_BYTES) return c.json({ error: 'bundle_too_large', limit: MAX_BUNDLE_BYTES }, 413);

  const entries: Record<string, Uint8Array> = {};
  const taken = new Set<string>();
  let missing = 0;
  for (const row of results) {
    const bytes = await c.env.KV.get(row.key, 'arrayBuffer');
    if (!bytes) {
      // Metadata without bytes is a storage inconsistency, not a reason to
      // fail the whole download — the manifest below records the gap.
      missing += 1;
      continue;
    }
    const path = uniqueEntry(taken, `${bundleFolder(row.code, row.title)}/${safeName(row.filename)}`);
    entries[path] = new Uint8Array(bytes);
  }
  if (Object.keys(entries).length === 0) return c.json({ error: 'no_files' }, 404);

  const zipped = zipSync(entries, { level: 0 });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(zipped as unknown as ArrayBuffer, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="submission-files-${stamp}.zip"`,
      'x-bundle-entries': String(Object.keys(entries).length),
      'x-bundle-missing': String(missing),
      'cache-control': 'private, no-store',
    },
  });
});

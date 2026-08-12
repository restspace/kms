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
  autoMap,
  commitStatements,
  fieldsFor,
  isImportTarget,
  parseUpload,
  planImport,
  type ImportTarget,
} from '../importer';
import { isImportSource, type ImportSource } from '../sourceProfiles';
import { toCsv } from '../export';

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

/** Optional source field ('generic' when absent); undefined = invalid. */
const resolveSource = (raw: unknown): ImportSource | undefined => {
  if (raw === undefined || raw === null || raw === '') return 'generic';
  return isImportSource(raw) ? raw : undefined;
};

/**
 * GET /app/api/import/fields?target=sessions&source=sessionboard — the mapping
 * step's catalogue for a (target, source) pair. Source defaults to 'generic',
 * which returns exactly the pre-sessionboard catalogue.
 */
importRoutes.get('/fields', (c) => {
  const target = c.req.query('target');
  if (!isImportTarget(target)) return c.json({ error: 'unknown_target' }, 400);
  const source = resolveSource(c.req.query('source'));
  if (!source) return c.json({ error: 'unknown_source' }, 400);
  return c.json({ target, source, fields: fieldsFor(target, source) });
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
  let rawSource: unknown;
  let headers: string[] = [];
  let rows: string[][] = [];
  let mapping: string[] | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    target = form.get('target');
    eventId = form.get('event_id');
    rawSource = form.get('source');
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
    rawSource = body.source;
    headers = Array.isArray(body.headers) ? body.headers.map((h) => String(h ?? '').trim()) : [];
    rows = asGrid(body.rows);
    if (Array.isArray(body.mapping)) mapping = body.mapping.map((v) => (typeof v === 'string' ? v : ''));
  }

  if (!isImportTarget(target)) return c.json({ error: 'unknown_target' }, 400);
  const source = resolveSource(rawSource);
  if (!source) return c.json({ error: 'unknown_source' }, 400);
  const scope = await targetEvent(c, eventId);
  if ('error' in scope) return c.json({ error: scope.error }, scope.status);
  if (headers.length === 0) return c.json({ error: 'no_header_row' }, 400);
  if (rows.length === 0) return c.json({ error: 'no_data_rows' }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: 'too_many_rows', limit: MAX_IMPORT_ROWS }, 400);

  const resolved = normaliseMapping(mapping, headers, target, source);
  const timezone = await eventTimezone(c, scope.eventId, source);
  const plan = await planImport({ db: c.env.DB, eventId: scope.eventId, source, timezone }, target, headers, rows, resolved);
  return c.json({ ...plan, event_id: scope.eventId, rows_raw: rows, fields: fieldsFor(target, source) });
});

/**
 * The event's IANA timezone, for the sessionboard datetime parsers. Only
 * fetched when a profile actually needs it, so the generic path issues exactly
 * the queries it did before this feature.
 */
async function eventTimezone(c: Context<AccessEnv>, eventId: string, source: ImportSource): Promise<string> {
  if (source === 'generic') return 'UTC';
  const row = await c.env.DB.prepare('SELECT timezone FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ timezone: string }>();
  return row?.timezone ?? 'UTC';
}

/** User mapping wins where it is valid; anything else is auto-mapped. */
function normaliseMapping(
  mapping: string[] | null,
  headers: string[],
  target: ImportTarget,
  source: ImportSource,
): string[] {
  if (!mapping) return autoMap(headers, target, source);
  const known = new Set(fieldsFor(target, source).map((f) => f.key));
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
  const source = resolveSource(body.source);
  if (!source) return c.json({ error: 'unknown_source' }, 400);
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
    source,
  );
  const timezone = await eventTimezone(c, scope.eventId, source);
  const plan = await planImport({ db: c.env.DB, eventId: scope.eventId, source, timezone }, target, headers, rows, mapping);

  // Eval defect (dry run said merge, commit created duplicates): the commit
  // re-plans against the LIVE database, so anything that moved the ground
  // between preview and commit — another organiser's writes, a demo reset, a
  // deleted merge target — silently produced a different plan from the one the
  // organiser just confirmed. The wizard now sends the per-row actions it
  // showed; if the re-plan disagrees, the commit refuses instead of applying a
  // plan nobody saw. Optional, so older clients (and the REST surface) keep
  // today's behaviour.
  if (Array.isArray(body.expected_actions)) {
    const expected = body.expected_actions.map((v) => String(v));
    const actual = plan.rows.map((r) => r.action);
    const drifted =
      expected.length !== actual.length || actual.some((action, i) => action !== expected[i]);
    if (drifted) {
      return c.json({ error: 'plan_changed', summary: plan.summary }, 409);
    }
  }

  // Sessionboard commits are recorded as an undoable batch (§5.5); generic
  // commits keep today's exact behaviour (no batch row, batchId: null).
  const batchId = source === 'sessionboard' ? crypto.randomUUID() : null;
  const { statements, applied, createdContactIds } = commitStatements(c.env.DB, scope.eventId, plan, batchId);
  let committedBatchId: string | null = null;
  if (statements.length > 0) {
    if (batchId) {
      // Same db.batch() as the plan statements, so the batch record and the
      // rows it stamps land (or fail) together. summary_json carries the
      // per-row report for report.csv and the created-contact ids for undo.
      const summaryJson = JSON.stringify({
        applied,
        rows: plan.rows.map((r) => ({ row: r.row, action: r.action, message: r.message, label: r.label })),
        createdContactIds,
        undone_at: null,
      });
      const filename = typeof body.filename === 'string' && body.filename ? body.filename.slice(0, 200) : null;
      statements.unshift(
        c.env.DB.prepare(
          `INSERT INTO import_batches (id, event_id, target, source, filename, created_by, created_at, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(batchId, scope.eventId, target, source, filename, c.get('session').contactId, new Date().toISOString(), summaryJson),
      );
      committedBatchId = batchId;
    }
    try {
      await c.env.DB.batch(statements);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'import_failed', detail }, 409);
    }
    await bumpEventRevision(c.env, scope.eventId);
  }
  return c.json({
    ok: true,
    target,
    event_id: scope.eventId,
    summary: plan.summary,
    applied,
    plan_rows: plan.rows,
    batchId: committedBatchId,
  });
});

// ---------------------------------------------------------------------------
// Import batches: history, undo, report (workplan-11 §5.5)
// ---------------------------------------------------------------------------

interface BatchSummary {
  applied?: Record<string, number>;
  rows?: { row: number; action: string; message: string | null; label: string }[];
  createdContactIds?: string[];
  undone_at?: string | null;
}

const parseSummary = (raw: string | null): BatchSummary => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as BatchSummary) : {};
  } catch {
    return {};
  }
};

interface BatchRow {
  id: string;
  event_id: string;
  target: string;
  source: string;
  filename: string | null;
  created_at: string;
  summary_json: string | null;
}

/** GET /app/api/import/batches?event_id=X — newest first, capped at 50. */
importRoutes.get('/batches', async (c) => {
  const scope = await targetEvent(c, c.req.query('event_id'));
  if ('error' in scope) return c.json({ error: scope.error }, scope.status);
  const { results } = await c.env.DB.prepare(
    `SELECT id, event_id, target, source, filename, created_at, summary_json
       FROM import_batches WHERE event_id = ? ORDER BY created_at DESC, id LIMIT 50`,
  )
    .bind(scope.eventId)
    .all<BatchRow>();
  return c.json({
    batches: results.map((b) => {
      const summary = parseSummary(b.summary_json);
      return {
        id: b.id,
        target: b.target,
        source: b.source,
        filename: b.filename,
        created_at: b.created_at,
        summary: summary.applied ?? null,
        undone_at: summary.undone_at ?? null,
      };
    }),
  });
});

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * POST /app/api/import/batches/:id/undo { event_id }
 *
 * Deletes exactly what the batch CREATED, in FK-safe order:
 *   1. submission_participants stamped with the batch (deleted first so their
 *      count is reported — the submissions cascade would otherwise eat them),
 *   2. submissions stamped with the batch (cascades cover answers, tags,
 *      uploads, any remaining participants),
 *   3. event_contacts memberships stamped with the batch (a contact `create`'s
 *      membership and an `attach`'s membership alike — undoing an attach
 *      removes the membership but leaves the org contact, which is correct:
 *      the person existed before the import),
 *   4. org `contacts` rows the batch minted (ids recorded in summary_json at
 *      commit time — contacts has no import_batch_id column), orphan-guarded:
 *      only when no event_contacts membership and no submission_participants
 *      row references them any more, and only inside the event's org.
 *
 * What undo does NOT touch: rows the import merely UPDATED or merged (v1
 * stores no per-column before-values; the fill-blanks-only merge policy
 * bounds the damage to "a blank became a value"), and pre-existing contacts.
 */
importRoutes.post('/batches/:id/undo', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const scope = await targetEvent(c, body.event_id);
  if ('error' in scope) return c.json({ error: scope.error }, scope.status);
  const id = c.req.param('id');

  const batch = await c.env.DB.prepare(
    'SELECT id, event_id, target, source, filename, created_at, summary_json FROM import_batches WHERE id = ? AND event_id = ?',
  )
    .bind(id, scope.eventId)
    .first<BatchRow>();
  if (!batch) return c.json({ error: 'not_found' }, 404);
  const summary = parseSummary(batch.summary_json);
  if (summary.undone_at) return c.json({ error: 'already_undone' }, 409);

  const db = c.env.DB;
  const statements = [
    db.prepare('DELETE FROM submission_participants WHERE import_batch_id = ?').bind(id),
    db.prepare('DELETE FROM submissions WHERE import_batch_id = ? AND event_id = ?').bind(id, scope.eventId),
    db.prepare('DELETE FROM event_contacts WHERE import_batch_id = ? AND event_id = ?').bind(id, scope.eventId),
  ];
  const createdContactIds = (summary.createdContactIds ?? []).filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  for (const group of chunk(createdContactIds, 80)) {
    statements.push(
      db
        .prepare(
          `DELETE FROM contacts
            WHERE id IN (${group.map(() => '?').join(', ')})
              AND org_id = (SELECT org_id FROM events WHERE id = ?)
              AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = contacts.id)
              AND NOT EXISTS (SELECT 1 FROM submission_participants sp WHERE sp.contact_id = contacts.id)`,
        )
        .bind(...group, scope.eventId),
    );
  }
  const undoneAt = new Date().toISOString();
  statements.push(
    db
      .prepare('UPDATE import_batches SET summary_json = ? WHERE id = ?')
      .bind(JSON.stringify({ ...summary, undone_at: undoneAt }), id),
  );

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'undo_failed', detail }, 409);
  }
  await bumpEventRevision(c.env, scope.eventId);
  return c.json({
    undone: {
      submission_participants: results[0]?.meta.changes ?? 0,
      submissions: results[1]?.meta.changes ?? 0,
      event_contacts: results[2]?.meta.changes ?? 0,
    },
  });
});

/** GET /app/api/import/batches/:id/report.csv?event_id=X — per-row report. */
importRoutes.get('/batches/:id/report.csv', async (c) => {
  const scope = await targetEvent(c, c.req.query('event_id'));
  if ('error' in scope) return c.json({ error: scope.error }, scope.status);
  const id = c.req.param('id');
  const batch = await c.env.DB.prepare(
    'SELECT summary_json FROM import_batches WHERE id = ? AND event_id = ?',
  )
    .bind(id, scope.eventId)
    .first<{ summary_json: string | null }>();
  if (!batch) return c.json({ error: 'not_found' }, 404);
  const summary = parseSummary(batch.summary_json);
  // Key order fixes the CSV column order (row,action,label,message) — toCsv
  // derives its header from first-seen key order, same escaping as export.ts.
  const rows = (summary.rows ?? []).map((r) => ({
    row: r.row,
    action: r.action,
    label: r.label,
    message: r.message ?? '',
  }));
  return c.body(toCsv(rows), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="import-report-${id}.csv"`,
    'cache-control': 'private, no-store',
  });
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
 *
 * Three sources feed the bundle, all folded into the same submission-code
 * folder structure via the `targets`/`target_contacts` CTEs:
 *  1. file_request_uploads keyed directly by submission_id (talk decks,
 *     slides — the original behaviour, unchanged).
 *  2. file_request_uploads with a NULL submission_id — a portal file-request
 *     task answered against a *contact* rather than a specific talk (e.g. a
 *     general "upload your ID" ask) — attributed to every selected
 *     submission that contact submits or speaks on.
 *  3. event_contacts.headshot_asset_id — the speaker-profile headshot,
 *     which has no file_request_uploads row at all, attributed the same way.
 * A contact who speaks on two selected submissions gets their profile-level
 * files (2) and (3) once per submission folder — deliberate: each folder is
 * a self-contained "everything for this talk" bundle.
 */
exportRoutes.post('/files.zip', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(body.submission_ids)
    ? [...new Set(body.submission_ids.filter((v): v is string => typeof v === 'string' && v !== ''))]
    : [];
  if (ids.length === 0) return c.json({ error: 'no_submissions' }, 400);

  const eventIds = await accessibleEventIds(c);
  const { results } = await c.env.DB.prepare(
    `WITH targets AS (
       SELECT s.id AS submission_id, s.event_id, s.code, s.title, s.submitter_contact_id
       FROM submissions s
       WHERE s.id IN (${ids.map(() => '?').join(', ')})
         AND s.event_id IN (${eventIds.map(() => '?').join(', ')})
     ),
     target_contacts AS (
       SELECT submission_id, event_id, submitter_contact_id AS contact_id
       FROM targets WHERE submitter_contact_id IS NOT NULL
       UNION
       SELECT sp.submission_id, t.event_id, sp.contact_id
       FROM submission_participants sp
       JOIN targets t ON t.submission_id = sp.submission_id
     )
     SELECT bundle.submission_id, bundle.uploaded_at, bundle.code, bundle.title,
            bundle.key, bundle.filename, bundle.size_bytes
     FROM (
       -- (1) uploads tied directly to the submission
       SELECT t.submission_id AS submission_id, u.uploaded_at AS uploaded_at,
              t.code AS code, t.title AS title,
              fa.key AS key, fa.filename AS filename, fa.size_bytes AS size_bytes
       FROM file_request_uploads u
       JOIN file_assets fa ON fa.id = u.file_asset_id
       JOIN targets t ON t.submission_id = u.submission_id
       WHERE u.is_current = 1

       UNION ALL

       -- (2) contact-level uploads (portal file-request tasks with no
       -- specific submission), attributed to every selected submission the
       -- uploader is on
       SELECT tc.submission_id AS submission_id, u.uploaded_at AS uploaded_at,
              t.code AS code, t.title AS title,
              fa.key AS key, fa.filename AS filename, fa.size_bytes AS size_bytes
       FROM file_request_uploads u
       JOIN file_assets fa ON fa.id = u.file_asset_id
       JOIN target_contacts tc ON tc.contact_id = u.contact_id
       JOIN targets t ON t.submission_id = tc.submission_id
       WHERE u.is_current = 1 AND u.submission_id IS NULL

       UNION ALL

       -- (3) speaker-profile headshots — never had a file_request_uploads row
       SELECT tc.submission_id AS submission_id, ec.added_at AS uploaded_at,
              t.code AS code, t.title AS title,
              fa.key AS key, fa.filename AS filename, fa.size_bytes AS size_bytes
       FROM event_contacts ec
       JOIN file_assets fa ON fa.id = ec.headshot_asset_id
       JOIN target_contacts tc ON tc.contact_id = ec.contact_id AND tc.event_id = ec.event_id
       JOIN targets t ON t.submission_id = tc.submission_id
       WHERE ec.headshot_asset_id IS NOT NULL
     ) bundle
     ORDER BY bundle.code, bundle.uploaded_at`,
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

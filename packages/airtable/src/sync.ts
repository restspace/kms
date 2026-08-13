// Watermark-sweep orchestration (workplan-9 §4.2): per table, read the
// watermark, query rows touched since, map, upsert to Airtable, advance the
// watermark. No per-write enqueue anywhere in the codebase — a mutating route
// only has to keep updated_at current, which is a mechanical convention, not a
// judgment call, so a missed site means one row lags until its next edit
// rather than never syncing.
//
// Watermark semantics: the new watermark is the time captured *before* the
// select (sweepStart), and the query uses `>=`, so a row touched mid-sweep is
// picked up again on the next sweep rather than dropped; the cost is at most
// one redundant (idempotent) re-upsert of rows whose updated_at lands exactly
// on the boundary. First sweep for a table has no watermark row and uses
// epoch — that IS the initial backfill (workplan-9 §8); there is no separate
// backfill path.
//
// Idempotency (D4): rows with airtable_record_id get PATCHed, rows without
// get created and the returned rec ids written back to D1 in one batch.
// Deletes staged in airtable_pending_deletes by the delete routes are drained
// last, so a row deleted mid-sweep can't resurrect after its delete.

import type { AirtableClient } from './client';
import {
  type Fields,
  mapComment,
  mapContact,
  mapEvent,
  mapEventContact,
  mapFile,
  mapFileRequest,
  mapMessage,
  mapPipelineActivity,
  mapPipelineCard,
  mapPortalResponse,
  mapReview,
  mapRoom,
  mapSubmission,
  mapTag,
  mapTask,
  mapTrack,
} from './mapping';

export interface SyncTableConfig {
  /** D1 table name: watermark key, record-id write-back target, pending-delete key */
  d1Table: string;
  airtableTable: string;
  /** must select id, airtable_record_id and bind ?1 = watermark against updated_at */
  selectSql: string;
  /**
   * Column the record-id write-back matches on, and the key the select must
   * expose. Defaults to `id`; event_contacts is keyed by (event_id, contact_id)
   * and supplies the generated `mirror_id` instead (migration 0045).
   */
  idColumn?: string;
  map: (row: Record<string, unknown>) => Fields;
}

/** Joined display name for the contacts row aliased `a` — what the mappers expect. */
const contactName = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;

// COALESCE(updated_at, created_at) on tasks/reviews guards rows written by any
// straggler INSERT that misses the new column; tracks/rooms/tags have no
// created_at so their inserts must set updated_at (backfilled by 0017).
export const SYNC_TABLES: SyncTableConfig[] = [
  {
    d1Table: 'events',
    airtableTable: 'Events',
    selectSql: `SELECT * FROM events WHERE updated_at >= ?1`,
    map: mapEvent,
  },
  {
    d1Table: 'contacts',
    airtableTable: 'Contacts',
    selectSql: `SELECT * FROM contacts WHERE updated_at >= ?1`,
    map: mapContact,
  },
  {
    d1Table: 'submissions',
    airtableTable: 'Submissions',
    selectSql: `SELECT s.*, e.name AS event_name, t.name AS track_name, r.name AS room_name,
                       TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS speaker_name,
                       c.email AS speaker_email,
                       -- Rating normalization (same fix as adminApi.ts's
                       -- submissions 'rating' column/sort): rating_cache holds
                       -- each plan's raw mean on that plan's own
                       -- scoring_scale_min/max, so pooling it as-is mixes
                       -- units across rounds on different scales. Map each
                       -- cached value onto a common 1-5 display scale before
                       -- averaging; a single 1-5 plan is numerically unchanged
                       -- (1 + (avg - 1) * 4 / 4 = avg).
                       (SELECT AVG(1 + (je.value - p.scoring_scale_min) * 4.0 / (p.scoring_scale_max - p.scoring_scale_min))
                        FROM json_each(COALESCE(s.rating_cache, '{}')) je
                        JOIN evaluation_plans p ON p.id = je.key) AS rating_normalized
                FROM submissions s
                JOIN events e ON e.id = s.event_id
                LEFT JOIN tracks t ON t.id = s.track_id
                LEFT JOIN rooms r ON r.id = s.room_id
                LEFT JOIN contacts c ON c.id = s.submitter_contact_id
                WHERE s.updated_at >= ?1`,
    map: mapSubmission,
  },
  {
    d1Table: 'tasks',
    airtableTable: 'Tasks',
    selectSql: `SELECT k.*, e.name AS event_name
                FROM tasks k JOIN events e ON e.id = k.event_id
                WHERE COALESCE(k.updated_at, k.created_at) >= ?1`,
    map: mapTask,
  },
  {
    d1Table: 'reviews',
    airtableTable: 'Reviews',
    selectSql: `SELECT v.*, s.code AS submission_code, s.title AS submission_title, e.name AS event_name,
                       TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS reviewer_name,
                       c.email AS reviewer_email
                FROM reviews v
                JOIN submissions s ON s.id = v.submission_id
                JOIN events e ON e.id = s.event_id
                JOIN contacts c ON c.id = v.reviewer_contact_id
                WHERE COALESCE(v.updated_at, v.created_at) >= ?1`,
    map: mapReview,
  },
  {
    d1Table: 'tracks',
    airtableTable: 'Tracks',
    selectSql: `SELECT t.*, e.name AS event_name
                FROM tracks t JOIN events e ON e.id = t.event_id
                WHERE t.updated_at >= ?1`,
    map: mapTrack,
  },
  {
    d1Table: 'rooms',
    airtableTable: 'Rooms',
    selectSql: `SELECT r.*, e.name AS event_name
                FROM rooms r JOIN events e ON e.id = r.event_id
                WHERE r.updated_at >= ?1`,
    map: mapRoom,
  },
  {
    d1Table: 'tags',
    airtableTable: 'Tags',
    selectSql: `SELECT g.*, e.name AS event_name
                FROM tags g JOIN events e ON e.id = g.event_id
                WHERE g.updated_at >= ?1`,
    map: mapTag,
  },
  // Second wave (migration 0045). updated_at on these tables is trigger-
  // maintained, so the plain `updated_at >= ?1` predicate holds even for the
  // ones whose routes have never heard of the mirror.
  {
    d1Table: 'event_contacts',
    airtableTable: 'Event Contacts',
    idColumn: 'mirror_id',
    selectSql: `SELECT ec.*, e.name AS event_name, c.email AS contact_email,
                       ${contactName('c')} AS contact_name
                FROM event_contacts ec
                JOIN events e ON e.id = ec.event_id
                JOIN contacts c ON c.id = ec.contact_id
                WHERE ec.updated_at >= ?1`,
    map: mapEventContact,
  },
  {
    d1Table: 'message_log',
    airtableTable: 'Messages',
    // LEFT JOIN on both: message_log.event_id is nullable (org-level mail) and
    // contact_id is SET NULL on contact delete, but the delivery record stays.
    selectSql: `SELECT m.*, e.name AS event_name, ${contactName('c')} AS contact_name
                FROM message_log m
                LEFT JOIN events e ON e.id = m.event_id
                LEFT JOIN contacts c ON c.id = m.contact_id
                WHERE m.updated_at >= ?1`,
    map: mapMessage,
  },
  {
    d1Table: 'submission_comments',
    airtableTable: 'Comments',
    selectSql: `SELECT sc.*, s.code AS submission_code, s.title AS submission_title, e.name AS event_name,
                       ${contactName('c')} AS author_fallback_name
                FROM submission_comments sc
                JOIN submissions s ON s.id = sc.submission_id
                JOIN events e ON e.id = sc.event_id
                LEFT JOIN contacts c ON c.id = sc.author_contact_id
                WHERE sc.updated_at >= ?1`,
    map: mapComment,
  },
  {
    d1Table: 'pipeline_cards',
    airtableTable: 'Pipeline',
    selectSql: `SELECT p.*, c.email AS contact_email, ${contactName('c')} AS contact_name
                FROM pipeline_cards p
                JOIN contacts c ON c.id = p.contact_id
                WHERE p.updated_at >= ?1`,
    map: mapPipelineCard,
  },
  {
    d1Table: 'pipeline_activity',
    airtableTable: 'Pipeline Activity',
    selectSql: `SELECT a.*, c.email AS contact_email, ${contactName('c')} AS contact_name
                FROM pipeline_activity a
                JOIN pipeline_cards p ON p.id = a.card_id
                JOIN contacts c ON c.id = p.contact_id
                WHERE a.updated_at >= ?1`,
    map: mapPipelineActivity,
  },
  {
    d1Table: 'file_assets',
    airtableTable: 'Files',
    // Which request an upload answered lives on file_request_uploads; resolving
    // it here to the request's title keeps that join table out of the base.
    selectSql: `SELECT f.*, e.name AS event_name, ${contactName('c')} AS uploader_name,
                       (SELECT r.title FROM file_request_uploads u
                         JOIN file_requests r ON r.id = u.file_request_id
                        WHERE u.file_asset_id = f.id LIMIT 1) AS request_title
                FROM file_assets f
                JOIN events e ON e.id = f.event_id
                LEFT JOIN contacts c ON c.id = f.uploaded_by_contact_id
                WHERE f.updated_at >= ?1`,
    map: mapFile,
  },
  {
    d1Table: 'file_requests',
    airtableTable: 'File Requests',
    selectSql: `SELECT r.*, e.name AS event_name
                FROM file_requests r JOIN events e ON e.id = r.event_id
                WHERE r.updated_at >= ?1`,
    map: mapFileRequest,
  },
  {
    d1Table: 'portal_form_responses',
    airtableTable: 'Portal Responses',
    selectSql: `SELECT pr.*, f.name AS form_name, f.questions AS form_questions, e.name AS event_name,
                       c.email AS contact_email, ${contactName('c')} AS contact_name,
                       s.title AS submission_title
                FROM portal_form_responses pr
                JOIN portal_forms f ON f.id = pr.portal_form_id
                JOIN events e ON e.id = f.event_id
                JOIN contacts c ON c.id = pr.contact_id
                LEFT JOIN submissions s ON s.id = pr.submission_id
                WHERE pr.updated_at >= ?1`,
    map: mapPortalResponse,
  },
];

const EPOCH = '1970-01-01T00:00:00.000Z';
const WRITEBACK_BATCH = 50;

export interface SyncReport {
  table: string;
  created: number;
  updated: number;
  /** Set when this table's pass failed; its watermark was left where it was. */
  error?: string;
}

export interface SyncOptions {
  log?: (message: string) => void;
  tables?: SyncTableConfig[];
  now?: () => string;
}

export async function runAirtableSync(
  d1: D1Database,
  client: AirtableClient,
  opts: SyncOptions = {},
): Promise<SyncReport[]> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const reports: SyncReport[] = [];

  for (const table of opts.tables ?? SYNC_TABLES) {
    // Per-table isolation: a table missing from the base 422s every write to
    // it, and without this one such table would abort the whole sweep and
    // strand the others. That is the normal state of an existing base right
    // after an upgrade adds tables, until someone presses "Create the tables".
    // The watermark is only advanced on success, so a failed table retries
    // from where it was on the next tick rather than skipping its rows.
    try {
      reports.push(await syncTable(d1, client, table, log, now));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${table.d1Table}: sweep failed, will retry (${message})`);
      reports.push({ table: table.d1Table, created: 0, updated: 0, error: message });
    }
  }

  await drainPendingDeletes(d1, client, log, opts.tables ?? SYNC_TABLES);
  return reports;
}

async function syncTable(
  d1: D1Database,
  client: AirtableClient,
  table: SyncTableConfig,
  log: (message: string) => void,
  now: () => string,
): Promise<SyncReport> {
  const state = await d1
    .prepare(`SELECT last_synced_at FROM airtable_sync_state WHERE table_name = ?`)
    .bind(table.d1Table)
    .first<{ last_synced_at: string }>();
  const watermark = state?.last_synced_at ?? EPOCH;
  if (!state) log(`${table.d1Table}: no watermark, initial backfill`);

  const sweepStart = now();
  const { results: rows } = await d1
    .prepare(table.selectSql)
    .bind(watermark)
    .all<Record<string, unknown>>();

  const creates = rows.filter((r) => !r.airtable_record_id);
  const updates = rows.filter((r) => r.airtable_record_id);

  if (creates.length > 0) {
    const recordIds = await client.createRecords(
      table.airtableTable,
      creates.map((r) => table.map(r)),
    );
    // d1Table and idColumn come from the static SYNC_TABLES config, never user input.
    const key = table.idColumn ?? 'id';
    const writeback = d1.prepare(`UPDATE ${table.d1Table} SET airtable_record_id = ? WHERE ${key} = ?`);
    for (let i = 0; i < creates.length; i += WRITEBACK_BATCH) {
      await d1.batch(
        creates
          .slice(i, i + WRITEBACK_BATCH)
          .map((row, j) => writeback.bind(recordIds[i + j], row[key])),
      );
    }
  }
  if (updates.length > 0) {
    await client.updateRecords(
      table.airtableTable,
      updates.map((r) => ({ id: r.airtable_record_id as string, fields: table.map(r) })),
    );
  }

  await d1
    .prepare(
      `INSERT INTO airtable_sync_state (table_name, last_synced_at) VALUES (?, ?)
       ON CONFLICT (table_name) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
    )
    .bind(table.d1Table, sweepStart)
    .run();

  if (rows.length > 0) log(`${table.d1Table}: ${creates.length} created, ${updates.length} updated`);
  return { table: table.d1Table, created: creates.length, updated: updates.length };
}

async function drainPendingDeletes(
  d1: D1Database,
  client: AirtableClient,
  log: (message: string) => void,
  tables: SyncTableConfig[],
): Promise<void> {
  const { results: pending } = await d1
    .prepare(`SELECT table_name, record_id FROM airtable_pending_deletes ORDER BY table_name`)
    .all<{ table_name: string; record_id: string }>();
  if (pending.length === 0) return;

  const byTable = new Map<string, string[]>();
  for (const row of pending) {
    const list = byTable.get(row.table_name) ?? [];
    list.push(row.record_id);
    byTable.set(row.table_name, list);
  }

  for (const [d1Table, recordIds] of byTable) {
    const config = tables.find((t) => t.d1Table === d1Table);
    if (!config) continue; // staged for a table this sweep doesn't mirror; leave it
    try {
      await client.deleteRecords(config.airtableTable, recordIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A rec id already gone on the Airtable side 404s the whole batch — the
      // mirror is already consistent, so fall through and clear the queue.
      // Anything else (network, 5xx) leaves the rows staged for the next sweep.
      if (!message.includes(': 404')) {
        log(`${d1Table}: delete batch failed, will retry (${message})`);
        continue;
      }
      log(`${d1Table}: delete batch 404 (already gone), clearing queue`);
    }
    const clear = d1.prepare(`DELETE FROM airtable_pending_deletes WHERE table_name = ? AND record_id = ?`);
    await d1.batch(recordIds.map((id) => clear.bind(d1Table, id)));
    log(`${d1Table}: ${recordIds.length} deleted`);
  }
}

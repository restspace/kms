// Demo reset vs the Airtable mirror (src/demo.ts). The replay deletes the demo
// organisation with raw SQL and lets FK cascades finish the job, so none of the
// delete routes' staging (airtableStage.ts) runs. Under test:
//  1. Rows the seed re-creates keep their airtable_record_id, so the next sweep
//     updates the existing Airtable record instead of creating a duplicate.
//  2. Rows that do not come back — created by demo users during the day — have
//     their record ids staged in airtable_pending_deletes for the sweep to drain.
//  3. The watermarks are cleared, so the seed's fixed past timestamps cannot
//     leave the restored rows looking older than their watermark and unsynced.
//  4. A deployment that has never mirrored is untouched by any of it.
//
// resetDemoData replays the real seed, so these assertions are against the
// seeded ids themselves rather than a fixture.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDemoData } from '../src/demo';

/** A seeded event and contact — deterministic ids, so they survive the replay. */
const SEEDED_EVENT = 'evt00000-0000-4000-8000-000000000001';
const SEEDED_CONTACT = 'con00000-0000-4000-8000-000000000001';

const pendingDeletes = () =>
  env.DB.prepare('SELECT table_name, record_id FROM airtable_pending_deletes ORDER BY record_id').all<{
    table_name: string;
    record_id: string;
  }>();

const recordIdOf = (table: string, id: string) =>
  env.DB.prepare(`SELECT airtable_record_id FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ airtable_record_id: string | null }>();

beforeEach(async () => {
  // Storage persists across it() blocks in this pool version — and the record
  // ids now survive a reset by design, so clear them explicitly or the previous
  // test's mirror state leaks into the next one.
  await env.DB.prepare('DELETE FROM airtable_pending_deletes').run();
  await env.DB.prepare('DELETE FROM airtable_sync_state').run();
  await resetDemoData(env.DB); // start from a known, freshly seeded demo org
  await env.DB.batch(
    ['events', 'contacts', 'submissions', 'tasks', 'reviews', 'tracks', 'rooms', 'tags'].map((t) =>
      env.DB.prepare(`UPDATE ${t} SET airtable_record_id = NULL`),
    ),
  );
});

describe('demo reset with the Airtable mirror in use', () => {
  /** Stand in for a sweep having run: give seeded rows Airtable record ids. */
  async function mirrorHasRun() {
    await env.DB.batch([
      env.DB.prepare('UPDATE events SET airtable_record_id = ? WHERE id = ?').bind('recEVENT1', SEEDED_EVENT),
      env.DB.prepare('UPDATE contacts SET airtable_record_id = ? WHERE id = ?').bind(
        'recCONTACT1',
        SEEDED_CONTACT,
      ),
      env.DB.prepare(
        `INSERT INTO airtable_sync_state (table_name, last_synced_at) VALUES ('events', '2026-08-13T00:00:00Z')`,
      ),
    ]);
  }

  it('carries record ids across the replay instead of duplicating them', async () => {
    await mirrorHasRun();

    await resetDemoData(env.DB);

    expect((await recordIdOf('events', SEEDED_EVENT))?.airtable_record_id).toBe('recEVENT1');
    expect((await recordIdOf('contacts', SEEDED_CONTACT))?.airtable_record_id).toBe('recCONTACT1');
    expect((await pendingDeletes()).results).toEqual([]);
  });

  it('stages a delete for a row the replay does not bring back', async () => {
    await mirrorHasRun();
    // A contact created in the demo during the day: mirrored, then wiped by the
    // replay because it is not in the seed.
    await env.DB.prepare(
      `INSERT INTO contacts (id, org_id, email, first_name, last_name, airtable_record_id, created_at, updated_at)
       SELECT 'con-walkin', id, 'walkin@example.com', 'Wal', 'Kin', 'recWALKIN', '2026-08-13T09:00:00Z', '2026-08-13T09:00:00Z'
       FROM organisations WHERE slug = 'ai-engineer'`,
    ).run();

    await resetDemoData(env.DB);

    expect((await pendingDeletes()).results).toEqual([{ table_name: 'contacts', record_id: 'recWALKIN' }]);
    // ...and the survivors are still not duplicated.
    expect((await recordIdOf('contacts', SEEDED_CONTACT))?.airtable_record_id).toBe('recCONTACT1');
  });

  it('clears the watermarks so the restored rows re-sync', async () => {
    await mirrorHasRun();

    await resetDemoData(env.DB);

    const state = await env.DB.prepare('SELECT COUNT(*) AS n FROM airtable_sync_state').first<{ n: number }>();
    expect(state?.n).toBe(0);
  });

  it('does nothing when the mirror has never run', async () => {
    await resetDemoData(env.DB);

    expect((await pendingDeletes()).results).toEqual([]);
    expect((await recordIdOf('events', SEEDED_EVENT))?.airtable_record_id).toBeNull();
  });
});

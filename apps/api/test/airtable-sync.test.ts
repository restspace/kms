// Airtable mirror sweep (workplan-9 §9): watermark backfill + idempotent
// re-sync, watermark advance semantics, per-row event attribution, the
// env-flag gate on the cron job, and delete staging/drain. The real
// AirtableClient is never used — a hand-rolled fake records every call and
// hands back deterministic rec ids. Storage persists across it() blocks in
// this pool-workers version, so every assertion is scoped to ids/titles
// minted by its own test and sweeps are restricted via opts.tables.

import { env } from 'cloudflare:test';
import type { AirtableClient, Fields } from '@kms/airtable';
import { runAirtableSync, SYNC_TABLES } from '@kms/airtable';
import { describe, expect, it } from 'vitest';
import { stageAirtableDeletes } from '../src/airtableStage';
import { sweepAirtableSync } from '../src/jobs/airtableSync';
import { createEvent } from './fixtures';

interface CreateCall {
  table: string;
  fieldsList: Fields[];
  ids: string[];
}
interface UpdateCall {
  table: string;
  records: Array<{ id: string; fields: Fields }>;
}
interface DeleteCall {
  table: string;
  ids: string[];
}

function makeFakeClient(prefix: string) {
  let counter = 0;
  const creates: CreateCall[] = [];
  const updates: UpdateCall[] = [];
  const deletes: DeleteCall[] = [];
  const client = {
    async createRecords(table: string, fieldsList: Fields[]): Promise<string[]> {
      const ids = fieldsList.map(() => `rec${prefix}${++counter}`);
      creates.push({ table, fieldsList, ids });
      return ids;
    },
    async updateRecords(table: string, records: Array<{ id: string; fields: Fields }>): Promise<void> {
      updates.push({ table, records });
    },
    async deleteRecords(table: string, ids: string[]): Promise<void> {
      deletes.push({ table, ids });
    },
  } as unknown as AirtableClient;
  return { client, creates, updates, deletes };
}

const tablesFor = (...names: string[]) => SYNC_TABLES.filter((t) => names.includes(t.d1Table));

/** All created field-sets for a table, flattened across calls, paired with their rec ids. */
function createdRecords(creates: CreateCall[], table: string): Array<{ fields: Fields; id: string }> {
  return creates
    .filter((c) => c.table === table)
    .flatMap((c) => c.fieldsList.map((fields, i) => ({ fields, id: c.ids[i] })));
}

async function insertSubmission(opts: {
  id: string;
  eventId: string;
  title: string;
  updatedAt: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(opts.id, opts.eventId, `code-${opts.id}`, opts.title, opts.updatedAt, opts.updatedAt).run();
}

describe('airtable mirror sweep', () => {
  it('sweepAirtableSync is a no-op when the flag is off or credentials are missing', async () => {
    const stateCountBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM airtable_sync_state`,
    ).first<{ n: number }>();

    await sweepAirtableSync({
      DB: env.DB,
      AIRTABLE_SYNC: 'off',
      AIRTABLE_API_KEY: 'key',
      AIRTABLE_BASE_ID: 'base',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // 'on' but no API key must also bail before touching the DB.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sweepAirtableSync({ DB: env.DB, AIRTABLE_SYNC: 'on', AIRTABLE_BASE_ID: 'base' } as any);

    const stateCountAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM airtable_sync_state`,
    ).first<{ n: number }>();
    expect(stateCountAfter?.n).toBe(stateCountBefore?.n);
  });

  it('initial backfill creates the record, and a later edit updates rather than re-creates', async () => {
    const title = `Backfill Talk ${crypto.randomUUID()}`;
    const eventId = await createEvent({ name: `Backfill Event ${crypto.randomUUID()}` });
    const eventName = (await env.DB.prepare(`SELECT name FROM events WHERE id = ?`)
      .bind(eventId)
      .first<{ name: string }>())!.name;
    const subId = `sub-${crypto.randomUUID()}`;
    await insertSubmission({ id: subId, eventId, title, updatedAt: '2026-08-01T00:00:00.000Z' });

    const { client, creates, updates } = makeFakeClient('BF');
    const tables = tablesFor('submissions');

    // Sweep 1: no watermark row yet -> epoch backfill picks the submission up.
    await runAirtableSync(env.DB, client, { tables, now: () => '2026-08-05T00:00:00.000Z' });

    const mine = createdRecords(creates, 'Submissions').filter((r) => r.fields.Title === title);
    expect(mine).toHaveLength(1);
    expect(mine[0].fields.Status).toBe('pending');
    expect(mine[0].fields.Event).toBe(eventName);

    const row = await env.DB.prepare(`SELECT airtable_record_id FROM submissions WHERE id = ?`)
      .bind(subId)
      .first<{ airtable_record_id: string | null }>();
    expect(row?.airtable_record_id).toBe(mine[0].id);

    // Sweep 2, nothing changed: watermark advanced past updated_at, so the
    // submission is not selected and createRecords sees no new copy of it.
    await runAirtableSync(env.DB, client, { tables, now: () => '2026-08-05T01:00:00.000Z' });
    expect(createdRecords(creates, 'Submissions').filter((r) => r.fields.Title === title)).toHaveLength(1);
    expect(updates.flatMap((u) => u.records).filter((r) => r.id === mine[0].id)).toHaveLength(0);

    // Edit the row after the watermark, sweep again: it must arrive as an
    // update against the stored rec id, never as a second create.
    const newTitle = `${title} v2`;
    await env.DB.prepare(`UPDATE submissions SET title = ?, updated_at = ? WHERE id = ?`)
      .bind(newTitle, '2026-08-05T02:00:00.000Z', subId)
      .run();
    await runAirtableSync(env.DB, client, { tables, now: () => '2026-08-05T03:00:00.000Z' });

    const updated = updates.flatMap((u) => u.records).filter((r) => r.id === mine[0].id);
    expect(updated).toHaveLength(1);
    expect(updated[0].fields.Title).toBe(newTitle);
    const created = creates
      .flatMap((c) => c.fieldsList)
      .filter((f) => f.Title === title || f.Title === newTitle);
    expect(created).toHaveLength(1); // still only the original backfill create
  });

  it('watermark equals injected sweep start; a row touched at the boundary syncs again next run', async () => {
    const title = `Boundary Talk ${crypto.randomUUID()}`;
    const eventId = await createEvent();
    const sweep1Start = '2026-08-06T10:00:00.000Z';
    // updated_at lands exactly on sweep 1's start: the >= query means the next
    // sweep re-selects it once more instead of dropping a mid-sweep touch.
    const subId = `sub-${crypto.randomUUID()}`;
    await insertSubmission({ id: subId, eventId, title, updatedAt: sweep1Start });

    const { client, creates, updates } = makeFakeClient('WM');
    const tables = tablesFor('submissions');

    await runAirtableSync(env.DB, client, { tables, now: () => sweep1Start });

    const state = await env.DB.prepare(
      `SELECT last_synced_at FROM airtable_sync_state WHERE table_name = 'submissions'`,
    ).first<{ last_synced_at: string }>();
    expect(state?.last_synced_at).toBe(sweep1Start);

    const created = createdRecords(creates, 'Submissions').filter((r) => r.fields.Title === title);
    expect(created).toHaveLength(1);

    // Run 2: updated_at >= watermark, so it syncs exactly once more — as an
    // update this time (rec id was written back after run 1).
    await runAirtableSync(env.DB, client, { tables, now: () => '2026-08-06T10:01:00.000Z' });
    expect(createdRecords(creates, 'Submissions').filter((r) => r.fields.Title === title)).toHaveLength(1);
    expect(updates.flatMap((u) => u.records).filter((r) => r.id === created[0].id)).toHaveLength(1);

    // Run 3: watermark is now past updated_at — no third sync.
    await runAirtableSync(env.DB, client, { tables, now: () => '2026-08-06T10:02:00.000Z' });
    expect(updates.flatMap((u) => u.records).filter((r) => r.id === created[0].id)).toHaveLength(1);
  });

  it('each submission carries its own event name in the Event field', async () => {
    const suffix = crypto.randomUUID();
    const eventAId = await createEvent({ name: `Event A ${suffix}` });
    const eventBId = await createEvent({ name: `Event B ${suffix}` });
    const titleA = `Talk A ${suffix}`;
    const titleB = `Talk B ${suffix}`;
    // Ahead of the watermark earlier tests in this file left behind (storage
    // persists across it() blocks), so both rows are guaranteed selected.
    await insertSubmission({
      id: `sub-${crypto.randomUUID()}`, eventId: eventAId, title: titleA, updatedAt: '2026-08-07T00:00:00.000Z',
    });
    await insertSubmission({
      id: `sub-${crypto.randomUUID()}`, eventId: eventBId, title: titleB, updatedAt: '2026-08-07T00:00:00.000Z',
    });

    const { client, creates } = makeFakeClient('EV');
    await runAirtableSync(env.DB, client, {
      tables: tablesFor('submissions'),
      now: () => '2026-08-08T00:00:00.000Z',
    });

    const records = createdRecords(creates, 'Submissions');
    const recA = records.filter((r) => r.fields.Title === titleA);
    const recB = records.filter((r) => r.fields.Title === titleB);
    expect(recA).toHaveLength(1);
    expect(recB).toHaveLength(1);
    expect(recA[0].fields.Event).toBe(`Event A ${suffix}`);
    expect(recB[0].fields.Event).toBe(`Event B ${suffix}`);
  });

  it('staged deletes are drained to the Airtable table and cleared from the queue', async () => {
    const eventId = await createEvent();
    const taskId = `task-${crypto.randomUUID()}`;
    const recId = `recDEL${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO tasks (id, event_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(taskId, eventId, `Doomed task ${taskId}`, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z').run();
    await env.DB.prepare(`UPDATE tasks SET airtable_record_id = ? WHERE id = ?`).bind(recId, taskId).run();

    // What a delete route does: stage first, then delete the D1 row.
    await stageAirtableDeletes(env.DB, 'tasks', 'id = ?', taskId).run();
    await env.DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(taskId).run();

    const staged = await env.DB.prepare(
      `SELECT table_name FROM airtable_pending_deletes WHERE record_id = ?`,
    ).bind(recId).first<{ table_name: string }>();
    expect(staged?.table_name).toBe('tasks');

    const { client, deletes } = makeFakeClient('DL');
    await runAirtableSync(env.DB, client, { tables: tablesFor('tasks') });

    const taskDeletes = deletes.filter((d) => d.table === 'Tasks').flatMap((d) => d.ids);
    expect(taskDeletes).toContain(recId);

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM airtable_pending_deletes WHERE record_id = ?`,
    ).bind(recId).first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});

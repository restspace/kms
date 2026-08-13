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

// Second wave (migration 0045). Every mapper is unit-tested against a fake row
// in packages/airtable; what needs a real database is the other half — that
// each selectSql parses and joins against the live schema, that it exposes the
// column the record-id write-back matches on, and that the trigger-maintained
// updated_at makes a row dirty when it should and not when it shouldn't.
describe('airtable mirror: the sweep against the real schema', () => {
  const EPOCH = '1970-01-01T00:00:00.000Z';

  for (const table of SYNC_TABLES) {
    it(`${table.d1Table}: the sweep query runs and selects its key column`, async () => {
      const key = table.idColumn ?? 'id';
      const { results } = await env.DB.prepare(table.selectSql).bind(EPOCH).all<Record<string, unknown>>();
      // The seed populates most of these; an empty table still proves the SQL
      // parses and binds, which is the failure this catches.
      for (const row of results.slice(0, 1)) {
        expect(Object.keys(row)).toContain(key);
        expect(Object.keys(row)).toContain('airtable_record_id');
        expect(row[key]).toBeTruthy();
      }
    });
  }

  it('one table failing (missing from the base) does not strand the others', async () => {
    const title = `Isolation Talk ${crypto.randomUUID()}`;
    const eventId = await createEvent();
    // Dated past any watermark the tests above left behind, so both tables
    // certainly have a row to create in this sweep.
    const future = '2999-01-01T00:00:00.000Z';
    await insertSubmission({ id: `sub-${crypto.randomUUID()}`, eventId, title, updatedAt: future });
    await env.DB.prepare(
      `INSERT INTO tasks (id, event_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(`task-${crypto.randomUUID()}`, eventId, `Isolation task ${title}`, future, future).run();

    const before = await env.DB.prepare(
      `SELECT last_synced_at FROM airtable_sync_state WHERE table_name = 'tasks'`,
    ).first<{ last_synced_at: string }>();

    // What Airtable returns for a table the base doesn't have yet — the state
    // of every existing base between an upgrade and pressing "Create the
    // tables". Tasks come before submissions in SYNC_TABLES order.
    const { client, creates } = makeFakeClient('ISO');
    const failing = {
      ...client,
      async createRecords(table: string, fieldsList: Fields[]) {
        if (table === 'Tasks') throw new Error('airtable POST Tasks: 422 TABLE_NOT_FOUND');
        return client.createRecords(table, fieldsList);
      },
    } as unknown as AirtableClient;

    const reports = await runAirtableSync(env.DB, failing, { tables: tablesFor('tasks', 'submissions') });

    expect(reports.find((r) => r.table === 'tasks')?.error).toContain('TABLE_NOT_FOUND');
    expect(createdRecords(creates, 'Submissions').filter((r) => r.fields.Title === title)).toHaveLength(1);

    // The failed table keeps its old watermark, so its rows retry next tick
    // instead of being silently skipped.
    const after = await env.DB.prepare(
      `SELECT last_synced_at FROM airtable_sync_state WHERE table_name = 'tasks'`,
    ).first<{ last_synced_at: string }>();
    expect(after?.last_synced_at).toBe(before?.last_synced_at);
  });

  it('event_contacts round-trips on its generated mirror_id, not an id column', async () => {
    const eventId = await createEvent({ name: `Roster Event ${crypto.randomUUID()}` });
    const contactId = `con-${crypto.randomUUID()}`;
    const company = `Acme ${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at)
       SELECT ?, org_id, ?, 'Ada', 'Lovelace', ?, ? FROM events WHERE id = ?`,
    ).bind(contactId, `${contactId}@example.com`, EPOCH, EPOCH, eventId).run();
    await env.DB.prepare(
      `INSERT INTO event_contacts (event_id, contact_id, company, added_at, source)
       VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', 'admin')`,
    ).bind(eventId, contactId, company).run();

    const { client, creates, updates } = makeFakeClient('EC');
    const tables = tablesFor('event_contacts');
    // Real timestamps, not the injected ones the tests above use: updated_at
    // here comes from the SQL trigger, which reads the actual clock.
    await runAirtableSync(env.DB, client, { tables });

    const mine = createdRecords(creates, 'Event Contacts').filter((r) => r.fields.Company === company);
    expect(mine).toHaveLength(1);
    expect(mine[0].fields.Name).toBe('Ada Lovelace');

    // The write-back has to land on this roster row specifically — the whole
    // point of mirror_id, since (event_id, contact_id) is the real key.
    const stored = await env.DB.prepare(
      `SELECT airtable_record_id FROM event_contacts WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventId, contactId).first<{ airtable_record_id: string | null }>();
    expect(stored?.airtable_record_id).toBe(mine[0].id);

    // An edit after the watermark arrives as an update, never a second create.
    await env.DB.prepare(`UPDATE event_contacts SET job_title = 'Principal' WHERE event_id = ? AND contact_id = ?`)
      .bind(eventId, contactId)
      .run();
    await runAirtableSync(env.DB, client, { tables });

    expect(createdRecords(creates, 'Event Contacts').filter((r) => r.fields.Company === company)).toHaveLength(1);
    const mineUpdated = updates.flatMap((u) => u.records).filter((r) => r.id === mine[0].id);
    expect(mineUpdated).toHaveLength(1);
    expect(mineUpdated[0].fields['Job Title']).toBe('Principal');
  });

  it('updated_at is trigger-maintained: content edits dirty a row, record-id write-backs do not', async () => {
    const eventId = await createEvent();
    const contactId = `con-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO contacts (id, org_id, email, created_at, updated_at)
       SELECT ?, org_id, ?, ?, ? FROM events WHERE id = ?`,
    ).bind(contactId, `${contactId}@example.com`, EPOCH, EPOCH, eventId).run();
    // No updated_at in the INSERT — the trigger supplies it, which is what lets
    // ~20 unmodified write sites feed the mirror.
    await env.DB.prepare(
      `INSERT INTO event_contacts (event_id, contact_id, added_at, source) VALUES (?, ?, ?, 'admin')`,
    ).bind(eventId, contactId, '2026-08-01T00:00:00.000Z').run();

    const read = async () =>
      (await env.DB.prepare(`SELECT updated_at FROM event_contacts WHERE event_id = ? AND contact_id = ?`)
        .bind(eventId, contactId)
        .first<{ updated_at: string | null }>())!.updated_at;

    const onInsert = await read();
    expect(onInsert).toBeTruthy();

    await env.DB.prepare(`UPDATE event_contacts SET company = 'Acme' WHERE event_id = ? AND contact_id = ?`)
      .bind(eventId, contactId)
      .run();
    const afterEdit = await read();
    expect(afterEdit! > onInsert!).toBe(true);

    // The sweep's own write-back must not make the row dirty again, or every
    // created row would cost one redundant update on the next sweep.
    await env.DB.prepare(
      `UPDATE event_contacts SET airtable_record_id = 'recX' WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventId, contactId).run();
    expect(await read()).toBe(afterEdit);
  });
});

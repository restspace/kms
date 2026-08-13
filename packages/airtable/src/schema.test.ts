// Base setup (schema.ts). Under test:
//  1. BASE_SCHEMA covers every key the mappers emit — the invariant that keeps
//     "add a field to mapping.ts" from silently failing to land in Airtable.
//  2. ensureBaseSchema is additive and idempotent: creates missing tables,
//     appends missing columns to existing ones, no-ops on a finished base.
//  3. Incompatible existing columns are reported, never altered.
//  4. A 403 from the metadata API surfaces as AirtableScopeError.

import { describe, expect, it } from 'vitest';
import {
  AirtableMetaClient,
  AirtableScopeError,
  BASE_SCHEMA,
  ensureBaseSchema,
  parseBaseId,
  type TableSpec,
} from './schema';
import { mapContact, mapEvent, mapReview, mapRoom, mapSubmission, mapTag, mapTask, mapTrack } from './mapping';

const columns = (table: string) => BASE_SCHEMA.find((t) => t.name === table)!.fields.map((f) => f.name);

describe('BASE_SCHEMA matches the mappers', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['Events', mapEvent({})],
    ['Contacts', mapContact({})],
    ['Submissions', mapSubmission({})],
    ['Tasks', mapTask({})],
    ['Reviews', mapReview({})],
    ['Tracks', mapTrack({})],
    ['Rooms', mapRoom({})],
    ['Tags', mapTag({})],
  ];

  for (const [table, fields] of cases) {
    it(`${table} has a column for every mapped field`, () => {
      expect(columns(table).sort()).toEqual(Object.keys(fields).sort());
    });
  }

  it('starts every table with a text column (Airtable primary fields cannot be number/checkbox)', () => {
    for (const table of BASE_SCHEMA) expect(table.fields[0]!.type).toBe('singleLineText');
  });
});

/**
 * A fake metadata API: `tables` is the live base, mutated by create calls the
 * same way Airtable would, so idempotency is testable by running twice.
 */
function fakeMeta(tables: Array<{ id: string; name: string; fields: Array<{ name: string; type: string }> }> = []) {
  const calls: string[] = [];
  const meta = {
    async listTables() {
      return tables.map((t) => ({ ...t, fields: t.fields.map((f, i) => ({ id: `fld${i}`, ...f })) }));
    },
    async createTable(_baseId: string, table: TableSpec) {
      calls.push(`table:${table.name}`);
      tables.push({ id: `tbl${tables.length}`, name: table.name, fields: table.fields.map((f) => ({ ...f })) });
    },
    async createField(_baseId: string, tableId: string, field: { name: string; type: string }) {
      calls.push(`field:${tableId}:${field.name}`);
      tables.find((t) => t.id === tableId)!.fields.push({ name: field.name, type: field.type });
    },
  } as unknown as AirtableMetaClient;
  return { meta, calls, tables };
}

describe('parseBaseId', () => {
  it('takes the base id out of a copied base URL, table and view ids included', () => {
    expect(parseBaseId('https://airtable.com/appbrUQ7n7P0zFSL6/tblEn0t0UeFGHnLrl/viwYhZb2WIzFFKCj2')).toBe(
      'appbrUQ7n7P0zFSL6',
    );
    expect(parseBaseId('appbrUQ7n7P0zFSL6/tblEn0t0UeFGHnLrl/viwYhZb2WIzFFKCj2')).toBe('appbrUQ7n7P0zFSL6');
  });

  it('passes a bare id through, trimming whitespace', () => {
    expect(parseBaseId('  appbrUQ7n7P0zFSL6 ')).toBe('appbrUQ7n7P0zFSL6');
  });

  it('finds the id in a workspace URL', () => {
    expect(parseBaseId('https://airtable.com/workspaces/wspAbc123/appXYZ789/tblQ')).toBe('appXYZ789');
  });

  it('returns null when there is no base id to find', () => {
    expect(parseBaseId('')).toBeNull();
    expect(parseBaseId('my conference base')).toBeNull();
    expect(parseBaseId('tblEn0t0UeFGHnLrl')).toBeNull();
  });
});

describe('ensureBaseSchema', () => {
  it('creates every table in an empty base, then no-ops on a second run', async () => {
    const { meta, calls } = fakeMeta();

    const first = await ensureBaseSchema(meta, 'appX');
    expect(first.createdTables).toEqual(BASE_SCHEMA.map((t) => t.name));
    expect(first.addedFields).toEqual([]);
    expect(calls).toHaveLength(BASE_SCHEMA.length);

    const second = await ensureBaseSchema(meta, 'appX');
    expect(second.createdTables).toEqual([]);
    expect(second.addedFields).toEqual([]);
    expect(second.unchanged).toEqual(BASE_SCHEMA.map((t) => t.name));
    expect(calls).toHaveLength(BASE_SCHEMA.length); // no further writes
  });

  it('appends missing columns to an existing table without touching its data', async () => {
    const { meta, calls } = fakeMeta([
      { id: 'tblTags', name: 'Tags', fields: [{ name: 'Name', type: 'singleLineText' }] },
    ]);

    const report = await ensureBaseSchema(meta, 'appX');

    expect(report.addedFields).toEqual(['Tags.Color', 'Tags.Event']);
    expect(report.createdTables).not.toContain('Tags');
    expect(calls).toContain('field:tblTags:Color');
  });

  it('reports an incompatible column type instead of changing it', async () => {
    const roomColumns = columns('Rooms').map((name) => ({
      name,
      // Capacity is a number in BASE_SCHEMA; someone made it text by hand.
      type: 'singleLineText',
    }));
    const { meta, calls } = fakeMeta([{ id: 'tblRooms', name: 'Rooms', fields: roomColumns }]);

    const report = await ensureBaseSchema(meta, 'appX');

    expect(report.mismatched).toEqual(['Rooms.Capacity is singleLineText, expected number']);
    expect(report.unchanged).toContain('Rooms');
    expect(calls.some((c) => c.startsWith('field:tblRooms'))).toBe(false);
  });

  it('ignores a harmless type difference on a text column', async () => {
    const tagColumns = columns('Tags').map((name) => ({ name, type: 'multilineText' }));
    const { meta } = fakeMeta([{ id: 'tblTags', name: 'Tags', fields: tagColumns }]);

    expect((await ensureBaseSchema(meta, 'appX')).mismatched).toEqual([]);
  });
});

describe('AirtableMetaClient', () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('lists bases as id + name', async () => {
    const client = new AirtableMetaClient({
      apiKey: 'patX',
      fetchImpl: respond(200, { bases: [{ id: 'appA', name: 'Conf', permissionLevel: 'create' }] }),
    });
    expect(await client.listBases()).toEqual([{ id: 'appA', name: 'Conf' }]);
  });

  // Same "Illegal invocation" guard as client.test.ts: an unbound global fetch
  // called as this.fetchImpl(...) fails on workers.
  it('calls fetch bound to globalThis', async () => {
    const seen: unknown[] = [];
    const impl = function (this: unknown) {
      seen.push(this);
      return Promise.resolve(new Response('{"bases":[]}', { status: 200 }));
    } as unknown as typeof fetch;

    await new AirtableMetaClient({ apiKey: 'patX', fetchImpl: impl }).listBases();

    expect(seen).toEqual([globalThis]);
  });

  it('raises AirtableScopeError on a 403 so the UI can explain the token scopes', async () => {
    const client = new AirtableMetaClient({
      apiKey: 'patX',
      fetchImpl: respond(403, { error: { type: 'INVALID_PERMISSIONS' } }),
    });
    await expect(client.listBases()).rejects.toBeInstanceOf(AirtableScopeError);
  });

  it('raises a plain error for other failures', async () => {
    const client = new AirtableMetaClient({ apiKey: 'patX', fetchImpl: respond(404, { error: 'NOT_FOUND' }) });
    const err = await client.listTables('appX').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AirtableScopeError);
  });
});

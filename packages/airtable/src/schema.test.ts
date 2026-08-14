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
import {
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
import { SYNC_TABLES } from './sync';

const spec = (table: string) => BASE_SCHEMA.find((t) => t.name === table)!;
/** Every column setup creates for a table — scalar fields plus its link fields. */
const columns = (table: string) => [
  ...spec(table).fields.map((f) => f.name),
  ...(spec(table).links ?? []).map((l) => l.name),
];

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
    ['Event Contacts', mapEventContact({})],
    ['Messages', mapMessage({})],
    ['Comments', mapComment({})],
    ['Pipeline', mapPipelineCard({})],
    ['Pipeline Activity', mapPipelineActivity({})],
    ['Files', mapFile({})],
    ['File Requests', mapFileRequest({})],
    ['Portal Responses', mapPortalResponse({})],
  ];

  for (const [table, fields] of cases) {
    it(`${table} has a column for every mapped field`, () => {
      expect(columns(table).sort()).toEqual(Object.keys(fields).sort());
    });
  }

  // The list above is hand-written; this catches a table added to the sweep
  // whose mapper nobody thought to check here.
  it('covers every table the sweep writes to, and nothing else', () => {
    expect(cases.map(([table]) => table).sort()).toEqual(SYNC_TABLES.map((t) => t.airtableTable).sort());
    expect(BASE_SCHEMA.map((t) => t.name).sort()).toEqual(SYNC_TABLES.map((t) => t.airtableTable).sort());
  });

  it('starts every table with a text column (Airtable primary fields cannot be number/checkbox)', () => {
    for (const table of BASE_SCHEMA) expect(table.fields[0]!.type).toBe('singleLineText');
  });

  // The one invariant that keeps typecast from manufacturing junk records: a
  // link resolves against the target's primary field, so only a table whose
  // primary field is unique base-wide may be linked to. That is Events (Name)
  // and Contacts (Email) — submission codes and track/room/tag names all repeat
  // across events, and linking on those would merge unrelated rows.
  it('only links to Events and Contacts', () => {
    const targets = new Set(BASE_SCHEMA.flatMap((t) => (t.links ?? []).map((l) => l.table)));
    expect([...targets].sort()).toEqual(['Contacts', 'Events']);
  });

  it('points every link at a table that exists, under a name no scalar column uses', () => {
    const names = new Set(BASE_SCHEMA.map((t) => t.name));
    for (const table of BASE_SCHEMA) {
      const scalars = new Set(table.fields.map((f) => f.name));
      for (const spot of table.links ?? []) {
        expect(names.has(spot.table)).toBe(true);
        expect(scalars.has(spot.name)).toBe(false);
      }
    }
  });

  // Airtable creates the reciprocal field on the target automatically and names
  // it after the source table, so two links from one table into the same target
  // would collide there.
  it('never links one table into the same target twice', () => {
    for (const table of BASE_SCHEMA) {
      const targets = (table.links ?? []).map((l) => l.table);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  // Both link targets are swept before anything that points at them; otherwise
  // typecast invents a placeholder record and the real sweep duplicates it.
  it('sweeps the link targets first', () => {
    expect(SYNC_TABLES.slice(0, 2).map((t) => t.airtableTable)).toEqual(['Events', 'Contacts']);
  });
});

/**
 * A fake metadata API: `tables` is the live base, mutated by create calls the
 * same way Airtable would, so idempotency is testable by running twice.
 */
type FakeField = { name: string; type: string; options?: Record<string, unknown> };

function fakeMeta(tables: Array<{ id: string; name: string; fields: FakeField[] }> = []) {
  const calls: string[] = [];
  const meta = {
    async listTables() {
      return tables.map((t) => ({ ...t, fields: t.fields.map((f, i) => ({ id: `fld${i}`, ...f })) }));
    },
    async createTable(_baseId: string, table: TableSpec) {
      calls.push(`table:${table.name}`);
      tables.push({ id: `tbl${tables.length}`, name: table.name, fields: table.fields.map((f) => ({ ...f })) });
    },
    async createField(_baseId: string, tableId: string, field: FakeField) {
      calls.push(`field:${tableId}:${field.name}`);
      tables.find((t) => t.id === tableId)!.fields.push({ ...field });
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

/** How a finished base looks: link columns already the right type. */
const builtColumns = (table: string, scalarType = 'singleLineText') =>
  columns(table).map((name) => ({
    name,
    type: (spec(table).links ?? []).some((l) => l.name === name) ? 'multipleRecordLinks' : scalarType,
  }));

const LINK_COUNT = BASE_SCHEMA.reduce((n, t) => n + (t.links?.length ?? 0), 0);

describe('ensureBaseSchema', () => {
  it('creates every table in an empty base, then no-ops on a second run', async () => {
    const { meta, calls } = fakeMeta();

    const first = await ensureBaseSchema(meta, 'appX');
    expect(first.createdTables).toEqual(BASE_SCHEMA.map((t) => t.name));
    // Links can only be added once their targets exist, so they arrive as a
    // second pass of field creates rather than with the tables.
    expect(first.addedFields).toEqual(
      BASE_SCHEMA.flatMap((t) => (t.links ?? []).map((l) => `${t.name}.${l.name}`)),
    );
    expect(calls).toHaveLength(BASE_SCHEMA.length + LINK_COUNT);

    const second = await ensureBaseSchema(meta, 'appX');
    expect(second.createdTables).toEqual([]);
    expect(second.addedFields).toEqual([]);
    expect(second.unchanged).toEqual(BASE_SCHEMA.map((t) => t.name));
    expect(calls).toHaveLength(BASE_SCHEMA.length + LINK_COUNT); // no further writes
  });

  it('creates a link field pointing at the target table it just created', async () => {
    const { meta, tables } = fakeMeta();

    await ensureBaseSchema(meta, 'appX');

    const events = tables.find((t) => t.name === 'Events')!;
    const field = tables.find((t) => t.name === 'Tasks')!.fields.find((f) => f.name === 'Event Link');
    expect(field).toMatchObject({ type: 'multipleRecordLinks' });
    // toEqual, not toMatchObject: linkedTableId is the only option the create
    // endpoint accepts. isReversed and prefersSingleRecordLink read back on the
    // field once it exists, which makes them look settable — sending either
    // (or both) 422s the whole setup run with
    // INVALID_FIELD_TYPE_OPTIONS_FOR_CREATE. The fake meta client here accepts
    // anything, so this assertion is what stands in for the real API.
    expect(field!.options).toEqual({ linkedTableId: events.id });
  });

  it('appends missing columns to an existing table without touching its data', async () => {
    const { meta, calls } = fakeMeta([
      { id: 'tblTags', name: 'Tags', fields: [{ name: 'Name', type: 'singleLineText' }] },
    ]);

    const report = await ensureBaseSchema(meta, 'appX');

    expect(report.addedFields).toContain('Tags.Color');
    expect(report.addedFields).toContain('Tags.Event');
    // The upgrade path for a base built before links existed: it gains them.
    expect(report.addedFields).toContain('Tags.Event Link');
    expect(report.createdTables).not.toContain('Tags');
    expect(calls).toContain('field:tblTags:Color');
  });

  it('reports an incompatible column type instead of changing it', async () => {
    // Capacity is a number in BASE_SCHEMA; someone made it text by hand.
    const { meta, calls } = fakeMeta([{ id: 'tblRooms', name: 'Rooms', fields: builtColumns('Rooms') }]);

    const report = await ensureBaseSchema(meta, 'appX');

    expect(report.mismatched).toEqual(['Rooms.Capacity is singleLineText, expected number']);
    expect(report.unchanged).toContain('Rooms');
    expect(calls.some((c) => c.startsWith('field:tblRooms'))).toBe(false);
  });

  it('reports a link column someone left as plain text', async () => {
    const tagColumns = columns('Tags').map((name) => ({ name, type: 'singleLineText' }));
    const { meta } = fakeMeta([{ id: 'tblTags', name: 'Tags', fields: tagColumns }]);

    expect((await ensureBaseSchema(meta, 'appX')).mismatched).toEqual([
      'Tags.Event Link is singleLineText, expected a link to Events',
    ]);
  });

  it('ignores a harmless type difference on a text column', async () => {
    const { meta } = fakeMeta([{ id: 'tblTags', name: 'Tags', fields: builtColumns('Tags', 'multilineText') }]);

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

// Base setup: the tables and fields the sweep writes into, plus the metadata-API
// client that creates them. The sweep itself never creates schema (a missing
// table or column 422s every write), and asking an organiser to hand-build 8
// tables with 70-odd exactly-named columns is not a real setup path — so the
// Settings page drives this instead (routes/airtableAdmin.ts POST /settings/setup).
//
// This is a separate API surface from client.ts: different host path
// (/v0/meta/...), and it needs the PAT to carry schema.bases:read +
// schema.bases:write on top of the data.records scopes the mirror uses. A token
// with only the data scopes still mirrors fine — setup is the one thing it
// cannot do, and reports that as a scope error the UI can explain.

/** Field types we create. `text` is also the fallback for anything typecast handles. */
type FieldType = 'singleLineText' | 'multilineText' | 'number' | 'checkbox' | 'multipleRecordLinks';

export interface FieldSpec {
  name: string;
  type: FieldType;
  options?: Record<string, unknown>;
}

/**
 * A `multipleRecordLinks` column — Airtable's cross-table navigation, and what
 * lookups, rollups and "expand record" all ride on. Kept separate from `fields`
 * because it cannot be created in the same call as the table: the target table
 * must already exist, so ensureBaseSchema creates every table first and comes
 * back for the links (see there).
 */
export interface LinkSpec {
  name: string;
  /** Name of the BASE_SCHEMA table this points at. */
  table: string;
}

export interface TableSpec {
  name: string;
  fields: FieldSpec[];
  links?: LinkSpec[];
}

/**
 * Which links exist at all is decided in mapping.ts, not here: `typecast`
 * resolves a link by the target's *primary field* and invents a record when
 * nothing matches, so a target is only safe if its primary field is unique
 * base-wide. That is true of `Events`.Name and `Contacts`.Email and of nothing
 * else in the base — submission codes and track/room/tag names all repeat
 * across events. Those relationships stay plain text.
 */
const linkToEvent: LinkSpec = { name: 'Event Link', table: 'Events' };
const linkToContact = (name: string): LinkSpec => ({ name, table: 'Contacts' });

const text = (name: string): FieldSpec => ({ name, type: 'singleLineText' });
const long = (name: string): FieldSpec => ({ name, type: 'multilineText' });
const num = (name: string, precision = 0): FieldSpec => ({ name, type: 'number', options: { precision } });
const check = (name: string): FieldSpec => ({
  name,
  // Airtable rejects a checkbox field created without both options.
  type: 'checkbox',
  options: { icon: 'check', color: 'greenBright' },
});

/**
 * Must stay in step with mapping.ts — every key a mapper emits needs a column
 * here, or that value silently fails to land. mapping.test.ts asserts the two
 * agree, so adding a field to a mapper without adding it here fails the build.
 *
 * Field order matters on create: Airtable makes the first field the table's
 * primary field, which cannot be a checkbox or number, so each list starts with
 * a text column. `typecast: true` on every write means single-selects and dates
 * are unnecessary — plain text columns accept everything the mirror sends.
 */
export const BASE_SCHEMA: TableSpec[] = [
  {
    name: 'Events',
    fields: [
      text('Name'), text('Slug'), text('Type'), text('Location'), text('Timezone'),
      text('Starts At'), text('Ends At'), text('Website'), check('Agenda Published'),
    ],
  },
  {
    name: 'Contacts',
    fields: [
      text('Email'), text('First Name'), text('Last Name'), text('Salutation'), text('Honorific'),
      text('Pronouns'), text('Mobile Phone'), text('LinkedIn'), text('Twitter'), text('Website'),
    ],
  },
  {
    name: 'Submissions',
    fields: [
      text('Code'), text('Title'), text('Kind'), text('Status'), long('Description'),
      text('Format'), text('Level'), text('Language'), text('Track'), text('Room'),
      text('Starts At'), text('Ends At'), num('Capacity'), text('Speaker'), text('Speaker Email'),
      num('Rating', 2), long('Notes'), text('Event'),
    ],
    links: [linkToEvent, linkToContact('Speaker Link')],
  },
  {
    name: 'Tasks',
    fields: [
      text('Title'), long('Description'), text('Target'), text('Action'), text('Due At'),
      check('Required'), text('Event'),
    ],
    links: [linkToEvent],
  },
  {
    name: 'Reviews',
    fields: [
      text('Submission'), text('Submission Title'), text('Reviewer'), text('Reviewer Email'),
      num('Total', 2), long('Comment'), check('Conflict Of Interest'), text('Event'),
    ],
    links: [linkToEvent, linkToContact('Reviewer Link')],
  },
  { name: 'Tracks', fields: [text('Name'), text('Color'), text('Event')], links: [linkToEvent] },
  { name: 'Rooms', fields: [text('Name'), num('Capacity'), long('Notes'), text('Event')], links: [linkToEvent] },
  { name: 'Tags', fields: [text('Name'), text('Color'), text('Event')], links: [linkToEvent] },
  // Second wave (migration 0045). An existing base gains these by pressing
  // "Create the tables in Airtable" again — ensureBaseSchema is additive, so a
  // base built before this release keeps its data and grows the new tables.
  {
    name: 'Event Contacts',
    fields: [
      text('Name'), text('Email'), text('Event'), text('Company'), text('Job Title'),
      long('Biography'), long('Notes'), text('Speaker Status'), text('Arrived At'), text('Source'),
      text('Added At'), num('Prior Rating', 2), text('Prior Rating Note'),
    ],
    links: [linkToEvent, linkToContact('Contact Link')],
  },
  {
    name: 'Messages',
    fields: [
      text('To'), text('Subject'), text('Template'), text('Status'), long('Error'),
      text('Contact'), text('Event'), text('Created At'), text('Sent At'),
    ],
    links: [linkToEvent, linkToContact('Contact Link')],
  },
  {
    name: 'Comments',
    fields: [
      text('Submission'), text('Submission Title'), text('Author'), text('Role'), text('Kind'),
      long('Body'), text('Event'), text('Created At'),
    ],
    links: [linkToEvent, linkToContact('Author Link')],
  },
  {
    name: 'Pipeline',
    fields: [
      text('Contact'), text('Email'), text('Stage'), num('Score'), long('Rationale'),
      text('Created At'), text('Updated At'),
    ],
    links: [linkToContact('Contact Link')],
  },
  {
    name: 'Pipeline Activity',
    fields: [
      text('Contact'), text('Email'), text('Kind'), text('From Stage'), text('To Stage'),
      long('Body'), text('Author'), text('Created At'),
    ],
    links: [linkToContact('Contact Link')],
  },
  {
    name: 'Files',
    fields: [
      text('Filename'), text('Content Type'), num('Size KB', 1), text('Uploaded By'), text('Request'),
      text('Event'), text('Created At'),
    ],
    links: [linkToEvent, linkToContact('Uploader Link')],
  },
  {
    name: 'File Requests',
    fields: [
      text('Title'), text('Type'), long('Instructions'), text('Due At'), num('Max Size MB'),
      text('Event'),
    ],
    links: [linkToEvent],
  },
  {
    name: 'Portal Responses',
    fields: [
      text('Form'), text('Contact'), text('Email'), text('Submission'), long('Answers'),
      text('Submitted At'), text('Event'),
    ],
    links: [linkToEvent, linkToContact('Contact Link')],
  },
];

export interface AirtableBaseSummary {
  id: string;
  name: string;
}

/**
 * Pull the base id out of whatever the user pasted. Copying the base's URL is
 * the obvious move, and that URL carries the table and view ids too
 * (`airtable.com/appABC…/tblDEF…/viwGHI…`) — pasted whole, they end up
 * concatenated into every request path as a 404. Accepts a bare id, a full URL,
 * or a path fragment; returns null when there is no `app…` id in there at all.
 */
export function parseBaseId(raw: string): string | null {
  return /app[A-Za-z0-9]+/.exec(raw.trim())?.[0] ?? null;
}

interface LiveTable {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string; type: string }>;
}

/** Every column setup creates for a table: its scalar fields, then its links. */
export const expectedColumns = (spec: TableSpec): string[] => [
  ...spec.fields.map((f) => f.name),
  ...(spec.links ?? []).map((l) => l.name),
];

/**
 * What a base is still missing, changing nothing — the read-only half of
 * ensureBaseSchema, for the Settings page's "Test connection".
 *
 * Columns matter as much as tables here: the sweep sends every mapped field on
 * every write and Airtable 422s the whole request over a single unknown field
 * name, so a base holding all sixteen tables but lagging one column mirrors
 * nothing at all. That is exactly the state an existing base is in after an
 * upgrade adds fields, until someone presses "Create the tables" again.
 */
export function missingFromBase(live: Array<{ name: string; fields: Array<{ name: string }> }>): {
  tables: string[];
  fields: string[];
} {
  const byName = new Map(live.map((t) => [t.name, new Set(t.fields.map((f) => f.name))]));
  const tables: string[] = [];
  const fields: string[] = [];

  for (const spec of BASE_SCHEMA) {
    const columns = byName.get(spec.name);
    if (!columns) {
      tables.push(spec.name);
      continue;
    }
    for (const column of expectedColumns(spec)) {
      if (!columns.has(column)) fields.push(`${spec.name}.${column}`);
    }
  }

  return { tables, fields };
}

export interface AirtableMetaClientOptions {
  apiKey: string;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
}

/** Thrown when the PAT is valid but lacks the schema scopes setup needs. */
export class AirtableScopeError extends Error {}

/**
 * Airtable metadata API (schema, not records). Unthrottled: setup issues a few
 * dozen requests once, well inside the rate limit, and an organiser is watching
 * a spinner — client.ts's 250ms spacing exists for multi-thousand-record
 * backfills, which this is not.
 */
export class AirtableMetaClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AirtableMetaClientOptions) {
    this.apiKey = opts.apiKey;
    // Bound for the same reason as client.ts: an unbound global fetch called as
    // `this.fetchImpl(...)` is an "Illegal invocation" on workers.
    this.fetchImpl = (opts.fetchImpl ?? fetch).bind(globalThis);
  }

  /** Bases the token can see — the Settings page's base picker. */
  async listBases(): Promise<AirtableBaseSummary[]> {
    const body = (await this.request('GET', '/bases')) as { bases?: AirtableBaseSummary[] };
    return (body.bases ?? []).map((b) => ({ id: b.id, name: b.name }));
  }

  async listTables(baseId: string): Promise<LiveTable[]> {
    const body = (await this.request('GET', `/bases/${baseId}/tables`)) as { tables?: LiveTable[] };
    return body.tables ?? [];
  }

  async createTable(baseId: string, table: TableSpec): Promise<void> {
    await this.request('POST', `/bases/${baseId}/tables`, table);
  }

  async createField(baseId: string, tableId: string, field: FieldSpec): Promise<void> {
    await this.request('POST', `/bases/${baseId}/tables/${tableId}/fields`, field);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`https://api.airtable.com/v0/meta${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // 403 on a metadata path with a token that reads records fine means the
      // scopes are wrong, not the base — worth its own type so the UI can say so.
      if (res.status === 403 || /INVALID_PERMISSIONS|NOT_AUTHORIZED/i.test(detail)) {
        throw new AirtableScopeError(`airtable meta ${method} ${path}: ${res.status} ${detail}`);
      }
      throw new Error(`airtable meta ${method} ${path}: ${res.status} ${detail}`);
    }
    return res.status === 204 ? {} : res.json();
  }
}

export interface SetupReport {
  /** Tables created from scratch, in BASE_SCHEMA order. */
  createdTables: string[];
  /** Columns added to tables that already existed: "Submissions.Rating". */
  addedFields: string[];
  /** Existing columns whose type would break writes — reported, never altered. */
  mismatched: string[];
  /** Tables already complete before this run. */
  unchanged: string[];
}

/**
 * Make `baseId` match BASE_SCHEMA, and report what changed.
 *
 * Idempotent and additive only: existing tables keep their data, missing columns
 * are appended, and nothing is ever renamed, retyped or deleted. Re-running
 * after BASE_SCHEMA grows backfills the new columns; re-running on a finished
 * base is a no-op with an all-`unchanged` report.
 *
 * A column that exists with an incompatible type (a Rating that someone made
 * text, say) is listed in `mismatched` rather than corrected — retyping a
 * populated column is destructive and belongs to the human who made it.
 */
export async function ensureBaseSchema(meta: AirtableMetaClient, baseId: string): Promise<SetupReport> {
  const report: SetupReport = { createdTables: [], addedFields: [], mismatched: [], unchanged: [] };
  const touched = new Set<string>();
  const live = new Map((await meta.listTables(baseId)).map((t) => [t.name, t]));

  // Pass 1 — tables and their scalar columns. `links` is stripped from the
  // create payload: a link field needs its target's table id, which does not
  // exist yet for a table later in the list.
  for (const spec of BASE_SCHEMA) {
    const found = live.get(spec.name);

    if (!found) {
      await meta.createTable(baseId, { name: spec.name, fields: spec.fields });
      report.createdTables.push(spec.name);
      continue;
    }

    const columns = new Map(found.fields.map((f) => [f.name, f]));

    for (const field of spec.fields) {
      const column = columns.get(field.name);
      if (!column) {
        await meta.createField(baseId, found.id, field);
        report.addedFields.push(`${spec.name}.${field.name}`);
        touched.add(spec.name);
        continue;
      }
      // Text columns swallow anything typecast produces, so only the numeric and
      // boolean shapes are worth flagging — those genuinely reject bad writes.
      if (column.type !== field.type && (field.type === 'number' || field.type === 'checkbox')) {
        report.mismatched.push(`${spec.name}.${field.name} is ${column.type}, expected ${field.type}`);
      }
    }
  }

  // Pass 2 — the link columns, now that every table exists and has an id.
  // Re-listing is what makes that true for the tables pass 1 just created.
  if (BASE_SCHEMA.some((s) => s.links?.length)) {
    const withIds = new Map((await meta.listTables(baseId)).map((t) => [t.name, t]));

    for (const spec of BASE_SCHEMA) {
      const found = withIds.get(spec.name);
      if (!spec.links || !found) continue;
      const columns = new Map(found.fields.map((f) => [f.name, f]));

      for (const spot of spec.links) {
        const target = withIds.get(spot.table);
        if (!target) continue; // its table failed in pass 1; that error already surfaced
        const column = columns.get(spot.name);
        if (!column) {
          await meta.createField(baseId, found.id, {
            name: spot.name,
            type: 'multipleRecordLinks',
            // Every one of these is many-to-one (a submission has one event), so
            // Airtable should show a single chip and stop at one record.
            options: { linkedTableId: target.id, prefersSingleRecordLink: true },
          });
          report.addedFields.push(`${spec.name}.${spot.name}`);
          touched.add(spec.name);
          continue;
        }
        // A link column that is text takes the write (typecast stringifies the
        // array) but navigates nowhere — worth saying so, unlike a text/text
        // difference.
        if (column.type !== 'multipleRecordLinks') {
          report.mismatched.push(
            `${spec.name}.${spot.name} is ${column.type}, expected a link to ${spot.table}`,
          );
        }
      }
    }
  }

  report.unchanged = BASE_SCHEMA.filter((s) => !report.createdTables.includes(s.name) && !touched.has(s.name)).map(
    (s) => s.name,
  );
  return report;
}

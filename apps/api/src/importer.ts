// Spreadsheet import (FR-REV-8, docs/06 §6): parse → column-map → dry-run
// plan → commit, shared by the Sessions and Speakers importers.
//
// Everything here is *pure* except the two `plan*` functions that read the
// event's existing rows: parsing, header heuristics and row validation are
// plain data transforms so the wizard's preview and the commit endpoint run
// the exact same code. The commit endpoint never trusts the actions the
// browser shows — it re-plans server-side from (headers, rows, mapping) and
// applies the plan it computed itself.
//
// XLSX is read with the same trick export.ts uses to write it: an .xlsx is a
// zip of small XML parts, so fflate + a few regexes cover the shapes Excel,
// Numbers and Sheets emit (shared strings, inline strings, numbers). No
// SheetJS-sized dependency, and no separate "CSV only" gap in the UI.

import { unzipSync, strFromU8 } from 'fflate';
import { nextSessionCodeSql } from './sessionCode';
import {
  SESSIONBOARD_CONTACT_ALIASES,
  SESSIONBOARD_SESSION_ALIASES,
  excelSerialToIso,
  parseSpeakerCell,
  sessionboardDateToIso,
  sessionboardStatus,
  splitMulti,
  type ImportSource,
} from './sourceProfiles';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** RFC-4180 CSV: quoted fields, doubled quotes, CR/LF or LF line ends, BOM. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  // Trailing newlines and spacer rows carry no data; dropping them here keeps
  // "3 rows" in the preview meaning three importable rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const xmlUnescape = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** All `<t>` text inside one shared-string / inline-string element, runs joined. */
function textRuns(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out += m[1] ?? '';
  return xmlUnescape(out);
}

/** A1 column letters → 0-based index ("A" → 0, "AA" → 26). */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * First worksheet of an .xlsx as a grid of strings. Dates come back as the
 * underlying serial number — the import fields that accept dates parse ISO
 * text, so a spreadsheet column formatted as a date is reported as an invalid
 * value rather than silently mis-read (documented gap; ISO text imports fine).
 */
export function parseXlsx(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ImportParseError('unreadable_xlsx');
  }
  const shared: string[] = [];
  const sharedPart = files['xl/sharedStrings.xml'];
  if (sharedPart) {
    const xml = strFromU8(sharedPart);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1] ?? ''));
  }
  const sheetName = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0];
  if (!sheetName) throw new ImportParseError('no_worksheet');
  const sheet = strFromU8(files[sheetName] as Uint8Array);

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 's') {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = shared[Number(raw)] ?? '';
      } else if (type === 'inlineStr') {
        value = textRuns(inner);
      } else {
        value = xmlUnescape(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export class ImportParseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Sniffs the format from the filename, falling back to the zip magic number. */
export function parseUpload(filename: string, bytes: Uint8Array): string[][] {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (/\.xlsx$/i.test(filename) || isZip) return parseXlsx(bytes);
  return parseCsv(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// Field catalogue + header heuristics
// ---------------------------------------------------------------------------

export type ImportTarget = 'sessions' | 'contacts';

export interface ImportField {
  key: string;
  label: string;
  /** extra header spellings, normalised the same way as the header itself */
  aliases?: string[];
  required?: boolean;
  /** free-text note rendered under the field in the mapping step */
  hint?: string;
}

export const SESSION_FIELDS: ImportField[] = [
  { key: 'client_session_id', label: 'Session ID (upsert key)', aliases: ['session id', 'external id', 'client session id', 'ref', 'reference'], hint: 'Matches an existing session and updates it' },
  { key: 'code', label: 'Code', aliases: ['session code', 'submission code'] },
  { key: 'title', label: 'Title', aliases: ['session title', 'name', 'talk'], required: true },
  { key: 'description', label: 'Description', aliases: ['abstract', 'summary', 'synopsis'] },
  { key: 'format', label: 'Format', aliases: ['session type', 'type'] },
  { key: 'level', label: 'Level', aliases: ['audience level', 'difficulty'] },
  { key: 'language', label: 'Language' },
  { key: 'capacity', label: 'Capacity', aliases: ['seats', 'max attendees'] },
  { key: 'ceu_credits', label: 'CEU credits', aliases: ['credits', 'ceu'] },
  { key: 'status', label: 'Status' },
  { key: 'track', label: 'Track', aliases: ['track name', 'theme'], hint: 'Matched by name; unknown names create the track' },
  { key: 'room', label: 'Room', aliases: ['room name', 'venue', 'location'], hint: 'Matched by name; unknown names create the room' },
  { key: 'starts_at', label: 'Starts at', aliases: ['start', 'start time', 'starts'] },
  { key: 'ends_at', label: 'Ends at', aliases: ['end', 'end time', 'ends'] },
  { key: 'notes', label: 'Internal notes', aliases: ['note', 'organiser notes'] },
];

export const CONTACT_IMPORT_FIELDS: ImportField[] = [
  { key: 'email', label: 'Email', aliases: ['e-mail', 'email address', 'speaker email'], required: true, hint: 'The dedupe key within the organisation' },
  { key: 'first_name', label: 'First name', aliases: ['first', 'given name', 'forename'] },
  { key: 'last_name', label: 'Last name', aliases: ['last', 'surname', 'family name'] },
  { key: 'company', label: 'Company', aliases: ['organisation', 'organization', 'employer', 'affiliation'] },
  { key: 'job_title', label: 'Job title', aliases: ['title', 'role', 'position'] },
  { key: 'mobile_phone', label: 'Mobile phone', aliases: ['phone', 'mobile', 'telephone', 'cell'] },
  { key: 'biography', label: 'Biography', aliases: ['bio', 'about'] },
  { key: 'pronouns', label: 'Pronouns' },
  { key: 'salutation', label: 'Salutation', aliases: ['prefix'] },
  { key: 'honorific', label: 'Honorific', aliases: ['suffix'] },
  { key: 'gender', label: 'Gender' },
  { key: 'notes', label: 'Internal notes', aliases: ['note', 'organiser notes'] },
];

export const TARGET_FIELDS: Record<ImportTarget, ImportField[]> = {
  sessions: SESSION_FIELDS,
  contacts: CONTACT_IMPORT_FIELDS,
};

export const isImportTarget = (value: unknown): value is ImportTarget =>
  value === 'sessions' || value === 'contacts';

// Sessionboard-only session fields (workplan-11 G2/G9). Deliberately NOT added
// to the generic catalogue: backward compatibility for the generic source is
// byte-for-byte — a generic sheet with a "Speakers" column must keep mapping it
// to nothing, exactly as today.
const SESSIONBOARD_EXTRA_SESSION_FIELDS: ImportField[] = [
  {
    key: 'speakers',
    label: 'Speakers',
    aliases: SESSIONBOARD_SESSION_ALIASES.speakers,
    hint: 'Emails or exact full names, pipe-separated; matched against the contact pool — unmatched values import unlinked with a warning',
  },
  {
    key: 'tags',
    label: 'Tags',
    aliases: SESSIONBOARD_SESSION_ALIASES.tags,
    hint: 'Matched by name; unknown names create the tag',
  },
];

/**
 * The field catalogue for a (target, source) pair (workplan-11 §5.1 G1).
 * Generic returns the base catalogue untouched; sessionboard merges the
 * profile's extra header aliases onto the base fields and, for sessions,
 * appends the `speakers` and `tags` link fields.
 */
export function fieldsFor(target: ImportTarget, source: ImportSource = 'generic'): ImportField[] {
  if (source !== 'sessionboard') return TARGET_FIELDS[target];
  const aliasMap = target === 'sessions' ? SESSIONBOARD_SESSION_ALIASES : SESSIONBOARD_CONTACT_ALIASES;
  const merged = TARGET_FIELDS[target].map((field) => {
    const extra = aliasMap[field.key];
    return extra ? { ...field, aliases: [...(field.aliases ?? []), ...extra] } : field;
  });
  if (target === 'sessions') merged.push(...SESSIONBOARD_EXTRA_SESSION_FIELDS);
  return merged;
}

const normalise = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Column → field guesses. Exact (normalised) matches on the key, the label or
 * an alias win first across *all* columns, so a sheet with both "Title" and
 * "Job title" binds "Job title" to job_title before "Title" is considered for
 * it. Remaining columns fall back to a containment match. Every field is used
 * at most once; unmatched columns map to '' and are ignored on import.
 */
export function autoMap(headers: string[], target: ImportTarget, source: ImportSource = 'generic'): string[] {
  const fields = fieldsFor(target, source);
  const mapping = headers.map(() => '');
  const taken = new Set<string>();
  const tokensFor = (field: ImportField): string[] =>
    [field.key, field.label, ...(field.aliases ?? [])].map(normalise);

  const assign = (index: number, key: string) => {
    mapping[index] = key;
    taken.add(key);
  };

  for (const pass of ['exact', 'contains'] as const) {
    headers.forEach((header, index) => {
      if (mapping[index]) return;
      const norm = normalise(header);
      if (!norm) return;
      for (const field of fields) {
        if (taken.has(field.key)) continue;
        const tokens = tokensFor(field);
        const hit =
          pass === 'exact'
            ? tokens.includes(norm)
            : tokens.some((t) => t.length >= 4 && (norm.includes(t) || t.includes(norm)));
        if (hit) {
          assign(index, field.key);
          return;
        }
      }
    });
  }
  return mapping;
}

/** Mapping (possibly user-edited) → one record per data row. */
export function applyMapping(headers: string[], row: string[], mapping: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  mapping.forEach((key, index) => {
    if (!key) return;
    const value = (row[index] ?? '').trim();
    if (value !== '') out[key] = value;
  });
  void headers;
  return out;
}

// ---------------------------------------------------------------------------
// Dry-run plan
// ---------------------------------------------------------------------------

// `attach` is contacts-only, and new with migration 0015: the person already
// exists in the organisation but not on this event, so the commit adds them to
// this roster (seeding their profile from their most recent event) instead of
// minting a duplicate. It is neither a `create` — no new contact row — nor a
// `merge`, which writes to someone already on this event, and above all it is
// not a `skip`, because it always writes.
export type RowAction = 'create' | 'update' | 'merge' | 'attach' | 'skip' | 'error';

export interface PlannedRow {
  /** 1-based data row number, header excluded — what the preview shows. */
  row: number;
  action: RowAction;
  /** why this row was skipped / what will be merged; rendered in the preview */
  message: string | null;
  errors: string[];
  /** the record label (title / name) so the preview reads like the data */
  label: string;
  values: Record<string, string>;
  /** existing row this will write to, when the action is update/merge */
  targetId: string | null;
  /** for `merge`/`attach`: exactly the blank columns this row fills (never a clobber) */
  mergeFields: string[] | null;
  /**
   * Resolved speaker↔session links (workplan-11 §5.2) — commit inserts one
   * submission_participants row per entry. Null when the `speakers` field is
   * unmapped (always, for the generic source). `label` is the original cell
   * fragment, kept for the report.
   */
  speakerLinks: { contactId: string; label: string }[] | null;
  /**
   * Unmapped columns preserved as {original header: value} (workplan-11 §5.4)
   * — sessionboard source only; null means "write nothing", keeping the
   * generic path byte-for-byte.
   */
  extra: Record<string, string> | null;
}

export interface ImportPlan {
  target: ImportTarget;
  /** which source profile produced this plan ('generic' when none was named) */
  source: ImportSource;
  headers: string[];
  mapping: string[];
  rows: PlannedRow[];
  summary: Record<RowAction | 'total', number>;
  /** track/room names that do not exist yet and will be created on commit */
  newTracks: string[];
  newRooms: string[];
  /** tag names that do not exist yet and will be created on commit (G9) */
  newTags: string[];
  /** mapped fields the target does not know about are simply absent here */
  unmapped: string[];
  /**
   * Plan-level warnings (missing upsert key, unresolved speakers…). Absent
   * when there are none, so the generic preview payload gains no key.
   */
  warnings?: string[];
}

const emptySummary = (): Record<RowAction | 'total', number> => ({
  create: 0,
  update: 0,
  merge: 0,
  attach: 0,
  skip: 0,
  error: 0,
  total: 0,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * `IN (?, ?, …)` lookup over an arbitrary number of keys, chunked for D1.
 * `leading` is bound ahead of the keys — the contacts lookup needs the event id
 * twice (once to derive the org, once for the membership join), which numbered
 * placeholders cannot express alongside a generated `IN` list.
 */
async function lookupBy<T>(
  db: D1Database,
  sql: (placeholders: string) => string,
  leading: unknown[],
  keys: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (const group of chunk(keys, 80)) {
    if (group.length === 0) continue;
    const { results } = await db
      .prepare(sql(group.map(() => '?').join(', ')))
      .bind(...leading, ...group)
      .all<T>();
    out.push(...results);
  }
  return out;
}

const SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

const isoOrNull = (value: string | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export interface PlanContext {
  db: D1Database;
  eventId: string;
  /** source profile driving aliases + value normalisation; defaults to 'generic' */
  source?: ImportSource;
  /** the event's IANA timezone — needed by the sessionboard datetime parsers */
  timezone?: string;
}

/** Unmapped columns of one raw row as {header: trimmed value}, empties dropped. */
function collectExtra(headers: string[], row: string[], mapping: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  let any = false;
  headers.forEach((header, i) => {
    if (mapping[i]) return;
    const value = (row[i] ?? '').trim();
    if (header.trim() === '' || value === '') return;
    out[header] = value;
    any = true;
  });
  return any ? out : null;
}

/**
 * Sessionboard datetime cell → UTC instant. `sessionboardDateToIso` goes
 * first, NOT `isoOrNull`: `new Date('2026-09-14 09:00')` parses fine inside
 * Workers but reads the wall-clock as UTC, which is exactly the G5 bug this
 * exists to fix — the profile parser owns both the documented wall-clock
 * spelling and true ISO-with-offset values. A bare finite number is an Excel
 * serial date (parseXlsx's documented gap, G6). Anything else falls back to
 * the generic Date parse; null means all three failed and the row errors.
 */
function sessionboardWhen(value: string, timezone: string): string | null {
  const iso = sessionboardDateToIso(value, timezone);
  if (iso) return iso;
  const trimmed = value.trim();
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
    return excelSerialToIso(Number(trimmed), timezone);
  }
  return isoOrNull(value) ?? null;
}

/**
 * Sessions dry run. Upsert key is `client_session_id` when that column is
 * mapped and non-empty (docs/06 §6), falling back to `code`; a row that
 * matches neither creates a new submission with a freshly allocated SESS-n.
 * Track and room arrive as *names*, matched case-insensitively against the
 * event's library, and unknown names are created on commit (reported up front
 * as `newTracks` / `newRooms` so the dry run never hides a write).
 */
export async function planSessions(
  ctx: PlanContext,
  headers: string[],
  dataRows: string[][],
  mapping: string[],
): Promise<ImportPlan> {
  const source = ctx.source ?? 'generic';
  const timezone = ctx.timezone ?? 'UTC';
  const records = dataRows.map((row) => applyMapping(headers, row, mapping));
  const warnings: string[] = [];
  /** per-row informational notes (status degraded etc.) — never errors */
  const notes: string[][] = records.map(() => []);

  if (source === 'sessionboard') {
    records.forEach((values, i) => {
      // Status: translate through the profile map; the mapped value replaces
      // the raw one so preview and commit (which re-plans) agree. Unknown
      // statuses degrade to pending with a note, never an error (§5.3).
      if (values.status !== undefined) {
        const { status, note } = sessionboardStatus(values.status);
        values.status = status;
        if (note) notes[i]?.push(note);
      }
      // Datetimes: normalised to the UTC instant at plan time. A cell no
      // parser understands is left raw so the existing validation below
      // reports it as a row error, same as the generic path.
      for (const field of ['starts_at', 'ends_at'] as const) {
        const raw = values[field];
        if (raw === undefined) continue;
        const iso = sessionboardWhen(raw, timezone);
        if (iso) values[field] = iso;
      }
    });
  }

  const clientIds = records.map((r) => r.client_session_id).filter(Boolean) as string[];
  const codes = records.map((r) => r.code).filter(Boolean) as string[];
  const byClientId = new Map<string, string>();
  const byCode = new Map<string, string>();
  for (const row of await lookupBy<{ id: string; client_session_id: string }>(
    ctx.db,
    (p) => `SELECT id, client_session_id FROM submissions WHERE event_id = ? AND client_session_id IN (${p})`,
    [ctx.eventId],
    clientIds,
  )) {
    byClientId.set(row.client_session_id, row.id);
  }
  for (const row of await lookupBy<{ id: string; code: string }>(
    ctx.db,
    (p) => `SELECT id, code FROM submissions WHERE event_id = ? AND code IN (${p})`,
    [ctx.eventId],
    codes,
  )) {
    byCode.set(row.code, row.id);
  }

  const { results: trackRows } = await ctx.db
    .prepare('SELECT id, name FROM tracks WHERE event_id = ?')
    .bind(ctx.eventId)
    .all<{ id: string; name: string }>();
  const { results: roomRows } = await ctx.db
    .prepare('SELECT id, name FROM rooms WHERE event_id = ?')
    .bind(ctx.eventId)
    .all<{ id: string; name: string }>();
  const trackByName = new Map(trackRows.map((t) => [t.name.toLowerCase(), t.id]));
  const roomByName = new Map(roomRows.map((r) => [r.name.toLowerCase(), r.id]));

  // Speaker linking (§5.2) — any source, whenever the `speakers` field is
  // mapped (the generic catalogue has no such field, so generic mappings never
  // bind it). Lookups are batched across the whole file: emails resolve by
  // lower(email) in the event's ORG (same pool planContacts matches against),
  // names by exact case-insensitive whitespace-collapsed full-name match,
  // accepted only when exactly one org contact matches. Never a fuzzy guess.
  const speakerCells = records.map((r) => (r.speakers !== undefined ? parseSpeakerCell(r.speakers) : null));
  const emailToContact = new Map<string, string>();
  const nameToContact = new Map<string, { id: string; count: number }>();
  {
    const wantedEmails = new Set<string>();
    const wantedNames = new Set<string>();
    for (const cell of speakerCells) {
      for (const entry of cell ?? []) {
        if (entry.kind === 'email') wantedEmails.add(entry.value);
        else wantedNames.add(entry.value.toLowerCase());
      }
    }
    for (const row of await lookupBy<{ id: string; email: string }>(
      ctx.db,
      (p) => `SELECT id, lower(email) AS email FROM contacts
               WHERE org_id = (SELECT org_id FROM events WHERE id = ?) AND lower(email) IN (${p})`,
      [ctx.eventId],
      [...wantedEmails],
    )) {
      emailToContact.set(row.email, row.id);
    }
    for (const row of await lookupBy<{ id: string; full_name: string; n: number }>(
      ctx.db,
      (p) => `SELECT MIN(id) AS id, COUNT(*) AS n,
                     lower(trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) AS full_name
                FROM contacts
               WHERE org_id = (SELECT org_id FROM events WHERE id = ?)
                 AND lower(trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) IN (${p})
               GROUP BY full_name`,
      [ctx.eventId],
      [...wantedNames],
    )) {
      nameToContact.set(row.full_name, { id: row.id, count: row.n });
    }
  }

  // Tags (G9): matched by name against the event's tag library; unknown names
  // are reported in `newTags` and created on commit, mirroring tracks/rooms.
  const tagByName = new Map<string, string>();
  const newTags: string[] = [];
  if (records.some((r) => r.tags !== undefined)) {
    const { results: tagRows } = await ctx.db
      .prepare('SELECT id, name FROM tags WHERE event_id = ?')
      .bind(ctx.eventId)
      .all<{ id: string; name: string }>();
    for (const t of tagRows) tagByName.set(t.name.toLowerCase(), t.id);
  }

  const newTracks: string[] = [];
  const newRooms: string[] = [];
  const summary = emptySummary();
  const seenKeys = new Set<string>();

  const rows: PlannedRow[] = records.map((values, index) => {
    const errors: string[] = [];
    const rowNotes = notes[index] ?? [];
    const title = values.title ?? '';
    if (!title) errors.push('Title is required');
    if (values.status && !SUBMISSION_STATUSES.has(values.status)) {
      errors.push(`Unknown status "${values.status}"`);
    }
    if (values.capacity && !Number.isFinite(Number(values.capacity))) {
      errors.push(`Capacity "${values.capacity}" is not a number`);
    }
    if (values.ceu_credits && !Number.isFinite(Number(values.ceu_credits))) {
      errors.push(`CEU credits "${values.ceu_credits}" is not a number`);
    }
    for (const field of ['starts_at', 'ends_at'] as const) {
      if (values[field] && isoOrNull(values[field]) === null) {
        errors.push(`${field === 'starts_at' ? 'Start' : 'End'} time "${values[field]}" is not a date`);
      }
    }

    const key = values.client_session_id ? `cid:${values.client_session_id}` : values.code ? `code:${values.code}` : '';
    let action: RowAction;
    let message: string | null = null;
    let targetId: string | null = null;
    let speakerLinks: { contactId: string; label: string }[] | null = null;

    if (errors.length > 0) {
      action = 'error';
      message = errors[0] ?? null;
    } else if (key && seenKeys.has(key)) {
      action = 'skip';
      message = 'Duplicate of an earlier row in this file';
    } else {
      targetId = values.client_session_id
        ? byClientId.get(values.client_session_id) ?? null
        : values.code
          ? byCode.get(values.code) ?? null
          : null;
      action = targetId ? 'update' : 'create';
      if (key) seenKeys.add(key);
      const trackName = values.track;
      if (trackName) {
        const known = trackByName.has(trackName.toLowerCase());
        if (!known && !newTracks.some((n) => n.toLowerCase() === trackName.toLowerCase())) {
          newTracks.push(trackName);
        }
        if (!known) message = `New track "${trackName}" will be created`;
      }
      const roomName = values.room;
      if (roomName) {
        const known = roomByName.has(roomName.toLowerCase());
        if (!known && !newRooms.some((n) => n.toLowerCase() === roomName.toLowerCase())) {
          newRooms.push(roomName);
        }
        if (!known) {
          message = message
            ? `${message}; new room "${roomName}" will be created`
            : `New room "${roomName}" will be created`;
        }
      }
      // Tags: unknown names will be created on commit (mirrors tracks/rooms).
      for (const tagName of values.tags !== undefined ? splitMulti(values.tags) : []) {
        if (!tagByName.has(tagName.toLowerCase()) && !newTags.some((n) => n.toLowerCase() === tagName.toLowerCase())) {
          newTags.push(tagName);
        }
      }
      // Speakers: resolved links land on the row; unresolved or ambiguous
      // fragments degrade to a warning — never an error, never a guess (§5.2).
      const cell = speakerCells[index];
      if (cell) {
        speakerLinks = [];
        for (const entry of cell) {
          if (entry.kind === 'email') {
            const id = emailToContact.get(entry.value);
            if (id) {
              speakerLinks.push({ contactId: id, label: entry.value });
            } else {
              rowNotes.push(`speaker '${entry.value}' not found`);
              const line = `speaker '${entry.value}' not found`;
              if (!warnings.includes(line)) warnings.push(line);
            }
          } else {
            const match = nameToContact.get(entry.value.toLowerCase());
            if (match && match.count === 1) {
              speakerLinks.push({ contactId: match.id, label: entry.value });
            } else if (match) {
              rowNotes.push(`speaker '${entry.value}' matches multiple contacts — not linked`);
              const line = `speaker '${entry.value}' matches multiple contacts — not linked`;
              if (!warnings.includes(line)) warnings.push(line);
            } else {
              rowNotes.push(`speaker '${entry.value}' not found`);
              const line = `speaker '${entry.value}' not found`;
              if (!warnings.includes(line)) warnings.push(line);
            }
          }
        }
        if (speakerLinks.length === 0) speakerLinks = null;
      }
    }

    // Informational notes (degraded status, unresolved speakers) join the row
    // message — they are context, not errors, so error rows keep errors[0].
    if (action !== 'error' && rowNotes.length > 0) {
      message = [message, ...rowNotes].filter(Boolean).join('; ');
    }

    summary[action] += 1;
    summary.total += 1;
    return {
      row: index + 1, action, message, errors,
      label: title || values.code || '(untitled)', values, targetId, mergeFields: null,
      speakerLinks,
      extra: source === 'sessionboard' ? collectExtra(headers, dataRows[index] ?? [], mapping) : null,
    };
  });

  // Missing upsert key (§9.2): loud, and first in the list.
  if (source === 'sessionboard' && !mapping.includes('client_session_id')) {
    warnings.unshift(
      'No Session ID column mapped — every row will create a new session; re-running this import will duplicate.',
    );
  }

  return {
    target: 'sessions',
    source,
    headers,
    mapping,
    rows,
    summary,
    newTracks,
    newRooms,
    newTags,
    unmapped: headers.filter((_h, i) => !mapping[i]),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Contact columns an import may write (schema columns, minus the derived ones),
 * in the order the preview lists them. Migration 0015 split these across two
 * tables — identity on the org-level `contacts`, profile on the per-event
 * `event_contacts` — but the sheet knows nothing about that: the header names
 * and aliases in CONTACT_IMPORT_FIELDS are a documented CSV contract.
 */
const CONTACT_WRITABLE = [
  'first_name', 'last_name', 'company', 'job_title', 'mobile_phone',
  'biography', 'pronouns', 'salutation', 'honorific', 'gender', 'notes',
] as const;

/** Per-event profile columns — written to `event_contacts`. */
const CONTACT_PROFILE_WRITABLE: readonly string[] = ['company', 'job_title', 'biography', 'notes'];

/** Org-level identity columns — written to `contacts`. */
const CONTACT_IDENTITY_WRITABLE = CONTACT_WRITABLE.filter((c) => !CONTACT_PROFILE_WRITABLE.includes(c));

/**
 * The subset `db.contacts.attachToEvent` copies forward when a contact joins a
 * new event. `notes` is deliberately absent — one event team's private remarks
 * about a person must not follow them across the org — and so is the headshot,
 * which is an event-scoped asset.
 */
const CONTACT_SEEDED_PROFILE: readonly string[] = ['biography', 'company', 'job_title'];

/**
 * Speakers dry run. Dedupe is by lower-cased email *within the organisation* as
 * of 0015 (`UNIQUE (org_id, lower(email))` is the backstop), so importing
 * someone who already spoke at a sibling event matches them rather than minting
 * a second person:
 *  - email unknown to the org → `create` (new contact, attached to this event)
 *  - email already on THIS event → `merge` when the file can fill at least one
 *    blank column, else `skip` (fill-blanks only: an existing non-empty value
 *    is never clobbered)
 *  - email known to the org but NOT on this event → `attach`: they join this
 *    roster and their profile is seeded from their most recent event in the
 *    org. That is a write even when there is nothing left to fill, so it is
 *    reported as its own action rather than folded into `create` or `skip`.
 * The rubric fixture — two speakers already on this event plus one new person —
 * still reports 2 merged/skipped and 1 created.
 */
export async function planContacts(
  ctx: PlanContext,
  headers: string[],
  dataRows: string[][],
  mapping: string[],
): Promise<ImportPlan> {
  const source = ctx.source ?? 'generic';
  const records = dataRows.map((row) => applyMapping(headers, row, mapping));
  const emails = records
    .map((r) => (r.email ?? '').toLowerCase())
    .filter((e) => e !== '' && EMAIL_RE.test(e));

  type ExistingContact = {
    id: string;
    email: string;
    /** 1 when the contact already has an event_contacts row for THIS event */
    on_event: number;
  } & Record<string, string | number | null>;
  const existing = new Map<string, ExistingContact>();
  for (const row of await lookupBy<ExistingContact>(
    ctx.db,
    // Org-scoped on purpose (contract §"Org-wide lookup"): matching a person who
    // already exists elsewhere in the org is the entire point of the change. The
    // LEFT JOIN reports whether they are on THIS event — the merge/attach fork —
    // rather than filtering them out. `seed_*` is the profile attachToEvent will
    // copy over, so the fill-blanks list below only promises columns the commit
    // really leaves for the sheet to supply.
    (p) =>
      `SELECT c.id, c.email, ${CONTACT_IDENTITY_WRITABLE.map((col) => `c.${col}`).join(', ')},
              ec.contact_id IS NOT NULL AS on_event,
              ${CONTACT_PROFILE_WRITABLE.map((col) => `ec.${col}`).join(', ')},
              ${CONTACT_SEEDED_PROFILE.map((col) => `prev.${col} AS seed_${col}`).join(', ')}
         FROM contacts c
         LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
         LEFT JOIN (
           SELECT contact_id, ${CONTACT_SEEDED_PROFILE.join(', ')}
             FROM (
               SELECT pec.contact_id, ${CONTACT_SEEDED_PROFILE.map((col) => `pec.${col}`).join(', ')},
                      ROW_NUMBER() OVER (PARTITION BY pec.contact_id ORDER BY pec.added_at DESC) AS rn
                 FROM event_contacts pec
                 JOIN events pe ON pe.id = pec.event_id
                 -- The contact's own org: a seed must never cross an org boundary.
                 JOIN contacts pc ON pc.id = pec.contact_id AND pc.org_id = pe.org_id
             )
            WHERE rn = 1
         ) prev ON prev.contact_id = c.id
        WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?)
          AND lower(c.email) IN (${p})`,
    [ctx.eventId, ctx.eventId],
    emails,
  )) {
    existing.set(row.email.toLowerCase(), row);
  }

  const summary = emptySummary();
  const seen = new Set<string>();

  const rows: PlannedRow[] = records.map((values, index) => {
    const errors: string[] = [];
    const email = (values.email ?? '').toLowerCase();
    if (!email) errors.push('Email is required');
    else if (!EMAIL_RE.test(email)) errors.push(`"${values.email}" is not a valid email address`);
    if (email) values.email = email;

    const label = [values.first_name, values.last_name].filter(Boolean).join(' ') || values.email || '(no name)';
    let action: RowAction;
    let message: string | null = null;
    let targetId: string | null = null;
    let mergeFields: string[] | null = null;

    if (errors.length > 0) {
      action = 'error';
      message = errors[0] ?? null;
    } else if (seen.has(email)) {
      action = 'skip';
      message = 'Duplicate email earlier in this file';
    } else {
      seen.add(email);
      const match = existing.get(email);
      if (!match) {
        action = 'create';
      } else {
        targetId = match.id;
        const onEvent = match.on_event === 1;
        // What this event will hold once the row lands. The event_contacts
        // columns come back NULL for someone who is not on this event yet, so
        // the value to compare against is the seed rather than nothing.
        const current = (col: string): string | null => {
          const raw = !onEvent && CONTACT_SEEDED_PROFILE.includes(col) ? match[`seed_${col}`] : match[col];
          return typeof raw === 'string' ? raw : null;
        };
        const fills = CONTACT_WRITABLE.filter(
          (col) => values[col] !== undefined && (current(col) ?? '') === '',
        );
        mergeFields = [...fills];
        if (!onEvent) {
          action = 'attach';
          message =
            fills.length > 0
              ? `Already in this organisation — joining this event, filling ${fills.join(', ')}`
              : 'Already in this organisation — joining this event';
        } else if (fills.length > 0) {
          action = 'merge';
          message = `Existing speaker — filling ${fills.join(', ')}`;
        } else {
          action = 'skip';
          mergeFields = null;
          message = 'Existing speaker — nothing blank to fill';
        }
      }
    }

    summary[action] += 1;
    summary.total += 1;
    return {
      row: index + 1, action, message, errors, label, values, targetId, mergeFields,
      speakerLinks: null,
      extra: source === 'sessionboard' ? collectExtra(headers, dataRows[index] ?? [], mapping) : null,
    };
  });

  return {
    target: 'contacts',
    source,
    headers,
    mapping,
    rows,
    summary,
    newTracks: [],
    newRooms: [],
    newTags: [],
    unmapped: headers.filter((_h, i) => !mapping[i]),
  };
}

export function planImport(
  ctx: PlanContext,
  target: ImportTarget,
  headers: string[],
  dataRows: string[][],
  mapping: string[],
): Promise<ImportPlan> {
  return target === 'sessions'
    ? planSessions(ctx, headers, dataRows, mapping)
    : planContacts(ctx, headers, dataRows, mapping);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** Sentinels meaning "resolve this id from the name, inside the statement". */
const TRACK_LOOKUP = Symbol('track_lookup') as unknown as string;
const ROOM_LOOKUP = Symbol('room_lookup') as unknown as string;
/** Sentinel: merge the row's `extra` JSON over what is already stored. */
const EXTRA_MERGE = Symbol('extra_merge') as unknown as string;

/**
 * Statements for a plan, in the order they must run. Callers hand the whole
 * array to `db.batch()`, which D1 runs as one implicit transaction — so an
 * import either lands whole or not at all, and the rooms/tracks a row depends
 * on are inserted earlier in the same batch than the row referencing them.
 *
 * `batchId` (workplan-11 §5.5): null means "no batch" and produces exactly
 * today's SQL. Non-null stamps `import_batch_id` on every row this commit
 * CREATES — new submissions, new event_contacts memberships (a contact
 * `create`'s membership AND an `attach`'s membership both count: undo removes
 * the membership, which is what this batch added), and every
 * submission_participants link. Updated/merged rows are never stamped —
 * undo does not revert them (v1: no per-column before-values).
 * `createdContactIds` lists the org-level contacts rows this commit minted
 * (contacts has no import_batch_id column); the route stores them in the
 * batch's summary_json so undo can delete exactly those, orphan-guarded.
 */
export function commitStatements(
  db: D1Database,
  eventId: string,
  plan: ImportPlan,
  batchId: string | null = null,
): {
  statements: D1PreparedStatement[];
  applied: Record<RowAction | 'total', number>;
  createdContactIds: string[];
} {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const applied = emptySummary();
  const createdContactIds: string[] = [];

  if (plan.target === 'contacts') {
    const written = (row: PlannedRow, cols: readonly string[]): string[] =>
      cols.filter((c) => row.values[c] !== undefined);
    const identityOf = (cols: readonly string[]): string[] =>
      cols.filter((c) => !CONTACT_PROFILE_WRITABLE.includes(c));
    const profileOf = (cols: readonly string[]): string[] =>
      cols.filter((c) => CONTACT_PROFILE_WRITABLE.includes(c));

    /**
     * Identity fills land on the org-level `contacts` row, which has no
     * event_id to guard by any more. The org subquery is the guard that
     * replaces it — the planner matched this id inside this event's org, so an
     * id from another org updates nothing.
     */
    const pushIdentityFills = (row: PlannedRow, cols: string[]) => {
      if (cols.length === 0) return;
      statements.push(
        db
          .prepare(
            `UPDATE contacts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
             WHERE id = ? AND org_id = (SELECT org_id FROM events WHERE id = ?)`,
          )
          .bind(...cols.map((c) => row.values[c] ?? null), now, row.targetId, eventId),
      );
    };

    /**
     * Columns appended to a membership INSERT beyond today's list: the `extra`
     * JSON blob (§5.4) and the batch stamp (§5.5). Both empty on the generic
     * path, so the generated SQL stays byte-for-byte what it was.
     */
    const membershipTail = (row: PlannedRow): { cols: string[]; binds: unknown[] } => {
      const cols: string[] = [];
      const binds: unknown[] = [];
      if (row.extra) {
        cols.push('extra');
        binds.push(JSON.stringify(row.extra));
      }
      if (batchId) {
        cols.push('import_batch_id');
        binds.push(batchId);
      }
      return { cols, binds };
    };

    for (const row of plan.rows) {
      if (row.action === 'create') {
        const contactId = crypto.randomUUID();
        createdContactIds.push(contactId);
        const cols = ['email', ...identityOf(written(row, CONTACT_WRITABLE))];
        // The importer only ever knows an event, so org_id is derived in the
        // statement rather than read first.
        statements.push(
          db
            .prepare(
              `INSERT INTO contacts (id, org_id, created_at, updated_at, ${cols.join(', ')})
               VALUES (?, (SELECT org_id FROM events WHERE id = ?), ?, ?${', ?'.repeat(cols.length)})`,
            )
            .bind(contactId, eventId, now, now, ...cols.map((c) => row.values[c] ?? null)),
        );
        // A contact with no event_contacts row exists but appears in no roster,
        // so the insert and the attach are always a pair. Nothing to seed from:
        // this person is new to the whole org.
        const profile = profileOf(written(row, CONTACT_WRITABLE));
        const tail = membershipTail(row);
        const allCols = [...profile, ...tail.cols];
        statements.push(
          db
            .prepare(
              `INSERT INTO event_contacts (event_id, contact_id, added_at, source${allCols.length ? ', ' + allCols.join(', ') : ''})
               VALUES (?, ?, ?, 'import'${', ?'.repeat(allCols.length)})`,
            )
            .bind(eventId, contactId, now, ...profile.map((c) => row.values[c] ?? null), ...tail.binds),
        );
      } else if (row.action === 'attach' && row.targetId) {
        const fills = row.mergeFields ?? [];
        const fill = (c: string): string | null => (fills.includes(c) ? row.values[c] ?? null : null);
        const tail = membershipTail(row);
        const tailColSql = tail.cols.length ? ', ' + tail.cols.join(', ') : '';
        // Numbered placeholders continue after today's ?1..?7.
        const tailExprSql = tail.cols.map((_c, i) => `, ?${8 + i}`).join('');
        // Mirrors db.contacts.attachToEvent — seed biography/company/job_title
        // from the contact's most recent event in the SAME org, never the
        // headshot (an event-scoped asset) and never notes (one team's private
        // remarks) — with the sheet's values overlaid where the seed is empty.
        // COALESCE keeps the fill-blanks promise even though the row being
        // filled is created by this very statement.
        statements.push(
          db
            .prepare(
              `INSERT INTO event_contacts
                 (event_id, contact_id, biography, headshot_asset_id, company,
                  job_title, notes, added_at, source${tailColSql})
               SELECT ?1, ?2, COALESCE(prev.biography, ?4), NULL, COALESCE(prev.company, ?5),
                      COALESCE(prev.job_title, ?6), ?7, ?3, 'import'${tailExprSql}
                 FROM (SELECT ec.biography, ec.company, ec.job_title
                         FROM event_contacts ec
                         JOIN events e ON e.id = ec.event_id
                        WHERE ec.contact_id = ?2
                          AND e.org_id = (SELECT org_id FROM events WHERE id = ?1)
                        ORDER BY ec.added_at DESC
                        LIMIT 1) prev
               -- WHERE is not optional: after a SELECT with a FROM clause
               -- SQLite would otherwise read ON CONFLICT as a join constraint.
               WHERE true
               ON CONFLICT (event_id, contact_id) DO NOTHING`,
            )
            .bind(eventId, row.targetId, now, fill('biography'), fill('company'), fill('job_title'), fill('notes'), ...tail.binds),
        );
        // No prior event to seed from (or the person was attached between the
        // preview and now): the INSERT…SELECT above produced no row, so this
        // writes the bare membership plus whatever the sheet supplied. A no-op
        // when the first statement fired.
        statements.push(
          db
            .prepare(
              `INSERT INTO event_contacts
                 (event_id, contact_id, biography, company, job_title, notes, added_at, source${tailColSql})
               VALUES (?, ?, ?, ?, ?, ?, ?, 'import'${', ?'.repeat(tail.cols.length)})
               ON CONFLICT (event_id, contact_id) DO NOTHING`,
            )
            .bind(eventId, row.targetId, fill('biography'), fill('company'), fill('job_title'), fill('notes'), now, ...tail.binds),
        );
        pushIdentityFills(row, identityOf(fills));
      } else if (row.action === 'merge' && row.targetId && row.mergeFields?.length) {
        const profile = profileOf(row.mergeFields);
        const sets = profile.map((c) => `${c} = ?`);
        const binds: unknown[] = profile.map((c) => row.values[c] ?? null);
        if (row.extra) {
          // Merge-over on update: new keys win, old keys survive (json_patch
          // is RFC-7396 — our values are always strings, never null).
          sets.push(`extra = json_patch(COALESCE(extra, '{}'), ?)`);
          binds.push(JSON.stringify(row.extra));
        }
        if (sets.length > 0) {
          // The planner read this event's event_contacts row, so it exists and
          // a plain UPDATE lands the profile fills. event_id here is both the
          // membership filter and the tenancy guard.
          statements.push(
            db
              .prepare(
                `UPDATE event_contacts SET ${sets.join(', ')}
                 WHERE event_id = ? AND contact_id = ?`,
              )
              .bind(...binds, eventId, row.targetId),
          );
        }
        pushIdentityFills(row, identityOf(row.mergeFields));
      } else {
        applied[row.action] += 1;
        applied.total += 1;
        continue;
      }
      applied[row.action] += 1;
      applied.total += 1;
    }
    return { statements, applied, createdContactIds };
  }

  // Sessions: the library rows first, so a row that names a brand-new track or
  // room can bind its id without a second round trip.
  const trackIds = new Map<string, string>();
  const roomIds = new Map<string, string>();
  for (const name of plan.newTracks) {
    const id = crypto.randomUUID();
    trackIds.set(name.toLowerCase(), id);
    statements.push(
      db
        .prepare(
          `INSERT INTO tracks (id, event_id, name, position, updated_at)
           SELECT ?1, ?2, ?3, COALESCE((SELECT MAX(position) + 1 FROM tracks WHERE event_id = ?2), 0), ?4`,
        )
        .bind(id, eventId, name, now),
    );
  }
  for (const name of plan.newRooms) {
    const id = crypto.randomUUID();
    roomIds.set(name.toLowerCase(), id);
    statements.push(
      db
        .prepare(
          `INSERT INTO rooms (id, event_id, name, position, updated_at)
           SELECT ?1, ?2, ?3, COALESCE((SELECT MAX(position) + 1 FROM rooms WHERE event_id = ?2), 0), ?4`,
        )
        .bind(id, eventId, name, now),
    );
  }
  // Tags a row named that do not exist yet (G9). The link statements below
  // resolve tag ids by name inside the same batch, so these must run first.
  for (const name of plan.newTags) {
    statements.push(
      db.prepare('INSERT INTO tags (id, event_id, name) VALUES (?, ?, ?)').bind(crypto.randomUUID(), eventId, name),
    );
  }

  /** Column → bound value for the submission columns a session row writes. */
  const sessionColumns = (values: Record<string, string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'format', 'level', 'language', 'notes', 'client_session_id'] as const) {
      if (values[key] !== undefined) out[key] = values[key];
    }
    if (values.capacity !== undefined) out.capacity = Math.trunc(Number(values.capacity));
    if (values.ceu_credits !== undefined) out.ceu_credits = Number(values.ceu_credits);
    if (values.starts_at !== undefined) out.starts_at = isoOrNull(values.starts_at) ?? null;
    if (values.ends_at !== undefined) out.ends_at = isoOrNull(values.ends_at) ?? null;
    if (values.track !== undefined) out.track_id = trackIds.get(values.track.toLowerCase()) ?? TRACK_LOOKUP;
    if (values.room !== undefined) out.room_id = roomIds.get(values.room.toLowerCase()) ?? ROOM_LOOKUP;
    return out;
  };

  for (const row of plan.rows) {
    if (row.action !== 'create' && row.action !== 'update') {
      applied[row.action] += 1;
      applied.total += 1;
      continue;
    }
    const cols = sessionColumns(row.values);
    // `extra` (§5.4): stored whole on create, merged over what is already
    // there on update — new keys win, old keys survive (json_patch).
    if (row.extra) cols.extra = row.action === 'update' ? EXTRA_MERGE : JSON.stringify(row.extra);
    // A track/room that already existed is resolved by a correlated subquery
    // rather than a pre-read: `?n` still binds the *name*, so the mapping from
    // name to id happens inside the same transaction as the write.
    const expr = (col: string, index: number): string => {
      if (cols[col] === TRACK_LOOKUP) return `(SELECT id FROM tracks WHERE event_id = ?1 AND lower(name) = lower(?${index}))`;
      if (cols[col] === ROOM_LOOKUP) return `(SELECT id FROM rooms WHERE event_id = ?1 AND lower(name) = lower(?${index}))`;
      if (cols[col] === EXTRA_MERGE) return `json_patch(COALESCE(extra, '{}'), ?${index})`;
      return `?${index}`;
    };
    const bindFor = (col: string): unknown => {
      if (cols[col] === TRACK_LOOKUP) return row.values.track;
      if (cols[col] === ROOM_LOOKUP) return row.values.room;
      if (cols[col] === EXTRA_MERGE) return JSON.stringify(row.extra);
      return cols[col];
    };
    const keys = Object.keys(cols);

    // The submission id every dependent statement (participants, tag links)
    // hangs off: known for updates, generated up front for creates.
    const submissionId = row.action === 'update' && row.targetId ? row.targetId : crypto.randomUUID();

    if (row.action === 'update' && row.targetId) {
      // ?1 = event id, ?2 = target id, ?3 = updated_at, then the columns.
      // Deliberately NOT stamped with the batch id: only created rows belong
      // to a batch — undo never reverts an update.
      const sets = keys.map((col, i) => `${col} = ${expr(col, i + 4)}`);
      sets.push('updated_at = ?3');
      statements.push(
        db
          .prepare(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?2 AND event_id = ?1`)
          .bind(eventId, row.targetId, now, ...keys.map(bindFor)),
      );
    } else {
      // ?1 = event id, ?2 = new id, ?3 = created/updated_at, ?4 = status,
      // ?5 = explicit code (or null → allocator), then the columns from ?6.
      const status = row.values.status ?? (row.values.starts_at ? 'accepted' : 'pending');
      // COALESCE keeps ?5 referenced even when the sheet has no Code column:
      // D1 rejects a bind list longer than the highest placeholder used.
      const codeExpr = `COALESCE(?5, ${nextSessionCodeSql('?1')})`;
      const valueExprs = keys.map((col, i) => expr(col, i + 6));
      // Batch stamp appended after the value columns so the ?1..?5 layout —
      // and, with batchId null, the whole statement — is unchanged.
      const stampCol = batchId ? ', import_batch_id' : '';
      const stampExpr = batchId ? `, ?${6 + keys.length}` : '';
      statements.push(
        db
          .prepare(
            `INSERT INTO submissions (id, event_id, code, kind, status, source, created_at, updated_at${keys.length ? ', ' + keys.join(', ') : ''}${stampCol})
             VALUES (?2, ?1, ${codeExpr}, 'session', ?4, 'import', ?3, ?3${valueExprs.length ? ', ' + valueExprs.join(', ') : ''}${stampExpr})`,
          )
          .bind(eventId, submissionId, now, status, row.values.code ?? null, ...keys.map(bindFor), ...(batchId ? [batchId] : [])),
      );
    }

    // Speaker links (§5.2): one participants row per resolved contact, in cell
    // order. ON CONFLICT on the existing (submission_id, contact_id, role)
    // uniqueness keeps re-imports single-linked.
    for (const [position, link] of (row.speakerLinks ?? []).entries()) {
      statements.push(
        db
          .prepare(
            `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, title_at_time, org_at_time${batchId ? ', import_batch_id' : ''})
             VALUES (?2, ?3, ?4, 'speaker', ?5,
               (SELECT ec.job_title FROM event_contacts ec WHERE ec.contact_id = ?4 AND ec.event_id = ?1),
               (SELECT ec.company FROM event_contacts ec WHERE ec.contact_id = ?4 AND ec.event_id = ?1)${batchId ? ', ?6' : ''})
             ON CONFLICT (submission_id, contact_id, role) DO NOTHING`,
          )
          .bind(eventId, crypto.randomUUID(), submissionId, link.contactId, position, ...(batchId ? [batchId] : [])),
      );
    }

    // Tag links (G9): resolved by name inside the batch (the new tag rows were
    // inserted above). INSERT OR IGNORE on the (submission_id, tag_id) primary
    // key makes re-imports idempotent; LIMIT 1 guards against duplicate names
    // in the library (tags has no uniqueness on name).
    if (row.values.tags !== undefined) {
      for (const tagName of splitMulti(row.values.tags)) {
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO submission_tags (submission_id, tag_id)
               SELECT ?1, id FROM tags WHERE event_id = ?2 AND lower(name) = lower(?3)
               ORDER BY rowid LIMIT 1`,
            )
            .bind(submissionId, eventId, tagName),
        );
      }
    }

    applied[row.action] += 1;
    applied.total += 1;
  }
  return { statements, applied, createdContactIds };
}

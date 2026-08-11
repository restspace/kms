// Sessionboard import source profile (workplan 11, docs/tests/workplan-11
// §5.1): pure data plus pure functions layered on top of the generic
// spreadsheet importer. Nothing here touches D1 and nothing here imports
// from `./importer` — importer.ts will import *from* this module once the
// profile is wired into `autoMap`/`applyMapping`/`planSessions`, and a
// two-way import would be a circular dependency.
//
// Three things a "source" contributes (§5.1): extra header aliases merged
// into the existing field catalogue (G1), value normalisers the caller runs
// inside `applyMapping` (G3 status map, G4 pipe/semicolon/comma split, G5
// tz-aware datetime, G6 Excel serial dates), and the speaker-cell splitting
// used for the sessions→contacts link (G2, §5.2). Nothing below reaches into
// `submissions`/`event_contacts` — resolving a speaker fragment against the
// org contact pool is the caller's job, this module only classifies the
// fragment as an email or a name.

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

export type ImportSource = 'generic' | 'sessionboard';

export const isImportSource = (value: unknown): value is ImportSource =>
  value === 'generic' || value === 'sessionboard';

// ---------------------------------------------------------------------------
// Header aliases (G1) — merged onto SESSION_FIELDS / CONTACT_IMPORT_FIELDS'
// `aliases` arrays by the caller, keyed by the same field `key`. Alias
// strings are run through importer.ts's `normalise()` (lowercase, strip
// non-alphanumerics) exactly like the built-in aliases are, so they are
// written in the same natural, already-lower-cased spelling those use —
// there is no need to pre-normalise them here.
//
// `speakers` and `tags` are NEW field keys with no generic-catalogue
// counterpart (G2, G9): the caller adds them to the sessions field list only
// when the source is sessionboard.
// ---------------------------------------------------------------------------

export const SESSIONBOARD_SESSION_ALIASES: Record<string, string[]> = {
  client_session_id: ['session id', 'friendly id', 'id'],
  title: ['session name', 'session title'],
  description: ['session description', 'abstract'],
  starts_at: ['session start time', 'start date', 'session date'],
  ends_at: ['session end time', 'end date'],
  track: ['track name'],
  room: ['room name'],
  status: ['session status', 'custom status'],
  speakers: [
    'speaker', 'speakers', 'speaker name', 'speaker names',
    'speaker email', 'speaker emails', 'participants',
  ],
  tags: ['tag', 'tags', 'session tags'],
};

export const SESSIONBOARD_CONTACT_ALIASES: Record<string, string[]> = {
  email: ['speaker email', 'contact email'],
  first_name: ['first name'],
  last_name: ['last name'],
  company: ['company name', 'organization name'],
  job_title: ['job title', 'title'],
  biography: ['bio', 'speaker bio'],
  mobile_phone: ['phone number', 'mobile'],
};

// ---------------------------------------------------------------------------
// Status translation (G3, §5.3)
// ---------------------------------------------------------------------------

/**
 * Literal map, case-insensitively keyed, into the KMS submission vocabulary
 * (`draft | pending | accept_queue | accepted | decline_queue | declined |
 * withdrawn` — importer.ts's `SUBMISSION_STATUSES`). Exported so a test can
 * assert every right-hand value is a real KMS status without duplicating the
 * map by hand. `accept_queue` / `decline_queue` have no Sessionboard
 * equivalent (those are KMS-internal review states) and are deliberately
 * absent from the right-hand side.
 */
export const SESSIONBOARD_STATUS_MAP: Record<string, string> = {
  accepted: 'accepted',
  confirmed: 'accepted',
  approved: 'accepted',
  declined: 'declined',
  rejected: 'declined',
  withdrawn: 'withdrawn',
  cancelled: 'withdrawn',
  canceled: 'withdrawn',
  'under review': 'pending',
  'in review': 'pending',
  pending: 'pending',
  submitted: 'pending',
  received: 'pending',
  new: 'pending',
  draft: 'draft',
  'in progress': 'draft',
  incomplete: 'draft',
  composition: 'draft',
};

/**
 * Translates one Sessionboard status/custom-status value. Unknown values
 * (custom statuses are a first-class Sessionboard feature, not an edge case
 * — docs/15 research) degrade to `pending` with a message rather than an
 * import error (docs/15 §5, "never half-apply"); the caller is expected to
 * surface the note on the row and also stash the original value in `extra`.
 */
export function sessionboardStatus(value: string): { status: string; note: string | null } {
  const original = value.trim();
  const mapped = SESSIONBOARD_STATUS_MAP[original.toLowerCase()];
  if (mapped) return { status: mapped, note: null };
  return {
    status: 'pending',
    note: `Sessionboard status "${original}" not recognised — imported as pending`,
  };
}

// ---------------------------------------------------------------------------
// Multi-select splitting (G4, §5.2)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sessionboard's multi-select convention is `|`-separated; this also treats
 * `;` as a hard separator. `,` is trickier — Sessionboard doesn't document
 * comma-separated multi-select, and a bare comma is far more likely to be
 * inside a single value ("Last, First") than between two — so a comma only
 * splits a fragment when *every* piece it would produce looks like an email
 * address (the speakers-column case where commas genuinely do separate
 * addresses). Otherwise the fragment is kept whole, comma and all.
 */
export function splitMulti(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[|;]/)) {
    if (part.includes(',')) {
      const commaParts = part.split(',').map((p) => p.trim()).filter((p) => p !== '');
      if (commaParts.length > 1 && commaParts.every((p) => EMAIL_RE.test(p))) {
        out.push(...commaParts);
        continue;
      }
    }
    const trimmed = part.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timezone-aware datetime / serial-date parsing (G5, G6)
// ---------------------------------------------------------------------------

/** Excel's day-0 epoch, expressed as the day-1970 serial their own docs use
 * as the reference point: serial 25569 lands on 1970-01-01. */
const EXCEL_EPOCH_SERIAL_AT_1970 = 25569;

const tzDtfCache = new Map<string, Intl.DateTimeFormat>();
function tzDtf(tz: string): Intl.DateTimeFormat {
  let f = tzDtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    tzDtfCache.set(tz, f);
  }
  return f;
}

interface WallClockParts {
  y: number; mo: number; d: number; hh: number; mm: number; ss: number;
}

function utcInstantToWallClock(date: Date, tz: string): WallClockParts {
  const parts = tzDtf(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24; // en-CA can emit "24" at local midnight
  return {
    y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
    hh: hour, mm: Number(get('minute')), ss: Number(get('second')),
  };
}

/**
 * Wall-clock date/time in `tz` -> UTC instant, as an ISO string. Standard
 * technique (mirrors `eventDateToIso`'s `localDayToUtc` in adminApi.ts, not
 * imported from here to keep this module dependency-free): build a first
 * guess by reading the wall-clock numbers as if they were already UTC, then
 * measure how far that guess's *local* rendering in `tz` drifted from the
 * target and correct for it. Two passes settle the answer even across a DST
 * boundary, where the offset used to read the guess and the offset that
 * actually applies can differ by an hour.
 *
 * A wall-clock time that does not exist (a spring-forward gap) has no
 * "correct" answer; the iteration still converges to a stable instant near
 * the transition rather than throwing.
 */
function wallClockToUtc(y: number, mo: number, d: number, hh: number, mm: number, ss: number, tz: string): string {
  const target = Date.UTC(y, mo - 1, d, hh, mm, ss);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const local = utcInstantToWallClock(new Date(ts), tz);
    const localTs = Date.UTC(local.y, local.mo - 1, local.d, local.hh, local.mm, local.ss);
    ts += target - localTs;
  }
  return new Date(ts).toISOString();
}

const SESSIONBOARD_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses Sessionboard's documented session-datetime spelling
 * (`YYYY-MM-DD HH:mm`, also accepting `YYYY-MM-DD HH:mm:ss` and a bare
 * `YYYY-MM-DD` -> midnight) as wall-clock time *in the event's timezone*
 * (G5) and returns the UTC instant. A value that already carries an explicit
 * `Z`/offset is a full ISO instant, not a Sessionboard wall-clock cell, and
 * passes through unchanged (just re-serialised). Anything else that fails to
 * parse returns null rather than guessing.
 */
export function sessionboardDateToIso(value: string, timezone: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (ISO_WITH_OFFSET_RE.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const m = SESSIONBOARD_DATETIME_RE.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  return wallClockToUtc(
    Number(y), Number(mo), Number(d),
    Number(hh ?? '0'), Number(mm ?? '0'), Number(ss ?? '0'),
    timezone,
  );
}

/**
 * Excel's 1900-date-system serial (G6 — `parseXlsx`'s documented gap: cells
 * formatted as dates come back as the raw serial number). Day 25569 is
 * 1970-01-01; the fractional part is the time of day. Both are read as
 * wall-clock in the event timezone, same as `sessionboardDateToIso`. Guards
 * out non-finite and absurd values — anything before day 1 or past roughly
 * year 2477 (200,000 days) is not a real spreadsheet date, more likely a
 * stray numeric column that happened to land in a date-mapped field.
 */
export function excelSerialToIso(serial: number, timezone: string): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 200000) return null;
  const days = Math.floor(serial);
  const fractionOfDay = serial - days;
  const epochMs = (days - EXCEL_EPOCH_SERIAL_AT_1970) * 86400000;
  const dayInUtc = new Date(epochMs);
  const totalSeconds = Math.round(fractionOfDay * 86400);
  const hh = Math.floor(totalSeconds / 3600) % 24;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const ss = totalSeconds % 60;
  return wallClockToUtc(
    dayInUtc.getUTCFullYear(), dayInUtc.getUTCMonth() + 1, dayInUtc.getUTCDate(),
    hh, mm, ss, timezone,
  );
}

// ---------------------------------------------------------------------------
// Speaker cell classification (G2, §5.2)
// ---------------------------------------------------------------------------

export interface SpeakerCellEntry {
  kind: 'email' | 'name';
  value: string;
}

/**
 * Splits a Sessionboard "Speakers" cell and classifies each fragment. The
 * caller resolves `email` entries against the org contact pool directly and
 * `name` entries by exact case-insensitive full-name match (§5.2) — nothing
 * here touches the database, it only tells the caller which lookup to run.
 */
export function parseSpeakerCell(value: string): SpeakerCellEntry[] {
  return splitMulti(value).map((fragment): SpeakerCellEntry => {
    if (EMAIL_RE.test(fragment)) return { kind: 'email', value: fragment.toLowerCase() };
    return { kind: 'name', value: fragment.replace(/\s+/g, ' ').trim() };
  });
}

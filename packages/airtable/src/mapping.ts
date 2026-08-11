// D1 row → Airtable fields, one pure function per mirrored table
// (workplan-9 §7). The field lists are deliberate cuts, not schema mirrors:
// spreadsheet-useful columns only (names, statuses, emails), with foreign keys
// resolved to display names by the sweep queries in sync.ts and internal-only
// columns (JSON blobs, ids) left out. `Forms` is not mirrored at all (form
// config is meaningless in a spreadsheet) and there is no `Sessions` table —
// schedule columns ride on Submissions and a filtered "Sessions" view is
// built once in the Airtable base UI (workplan-9 §3).
//
// Empty strings and nulls map to explicit `null` so a value cleared in D1
// clears in Airtable on the next sweep (one-way overwrite mirror, D1).
// Renaming a field here after the base is in human use means renaming the
// Airtable column too — change with care.

const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const b = (v: unknown): boolean => v === 1 || v === true;

type Row = Record<string, unknown>;
export type Fields = Record<string, unknown>;

export function mapEvent(row: Row): Fields {
  return {
    Name: s(row.name),
    Slug: s(row.slug),
    Type: s(row.type),
    Location: s(row.location),
    Timezone: s(row.timezone),
    'Starts At': s(row.starts_at),
    'Ends At': s(row.ends_at),
    Website: s(row.website_url),
    'Agenda Published': b(row.agenda_published),
  };
}

/** Expects joined columns: event_name, track_name, room_name, speaker_name, speaker_email. */
export function mapSubmission(row: Row): Fields {
  return {
    Code: s(row.code),
    Title: s(row.title),
    Kind: s(row.kind),
    Status: s(row.status),
    Description: s(row.description),
    Format: s(row.format),
    Level: s(row.level),
    Language: s(row.language),
    Track: s(row.track_name),
    Room: s(row.room_name),
    'Starts At': s(row.starts_at),
    'Ends At': s(row.ends_at),
    Capacity: n(row.capacity),
    Speaker: s(row.speaker_name),
    'Speaker Email': s(row.speaker_email),
    Rating: averageRating(row.rating_cache),
    Notes: s(row.notes),
    Event: s(row.event_name),
  };
}

/** Mean across every plan's cached mean in rating_cache `{ "<plan_id>": 4.2 }`. */
export function averageRating(ratingCache: unknown): number | null {
  if (typeof ratingCache !== 'string' || ratingCache === '') return null;
  try {
    const values = Object.values(JSON.parse(ratingCache) as Record<string, unknown>).filter(
      (v): v is number => typeof v === 'number',
    );
    if (values.length === 0) return null;
    return Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 100) / 100;
  } catch {
    return null;
  }
}

export function mapContact(row: Row): Fields {
  const links = parseLinks(row.links);
  return {
    Email: s(row.email),
    'First Name': s(row.first_name),
    'Last Name': s(row.last_name),
    Salutation: s(row.salutation),
    Honorific: s(row.honorific),
    Pronouns: s(row.pronouns),
    'Mobile Phone': s(row.mobile_phone),
    LinkedIn: links.linkedin,
    Twitter: links.twitter,
    Website: links.website,
  };
}

function parseLinks(links: unknown): { linkedin: string | null; twitter: string | null; website: string | null } {
  const empty = { linkedin: null, twitter: null, website: null };
  if (typeof links !== 'string' || links === '') return empty;
  try {
    const parsed = JSON.parse(links) as Record<string, unknown>;
    return { linkedin: s(parsed.linkedin), twitter: s(parsed.twitter), website: s(parsed.website) };
  } catch {
    return empty;
  }
}

/** Expects joined column: event_name. */
export function mapTask(row: Row): Fields {
  return {
    Title: s(row.title),
    Description: s(row.description),
    Target: s(row.target),
    Action: s(row.action_type),
    'Due At': s(row.due_at),
    Required: b(row.required),
    Event: s(row.event_name),
  };
}

/** Expects joined columns: submission_code, submission_title, reviewer_name, reviewer_email, event_name. */
export function mapReview(row: Row): Fields {
  return {
    Submission: s(row.submission_code) ?? s(row.submission_title),
    'Submission Title': s(row.submission_title),
    Reviewer: s(row.reviewer_name),
    'Reviewer Email': s(row.reviewer_email),
    Total: n(row.weighted_total),
    Comment: s(row.comment),
    'Conflict Of Interest': b(row.conflict_of_interest),
    Event: s(row.event_name),
  };
}

/** Expects joined column: event_name. */
export function mapTrack(row: Row): Fields {
  return { Name: s(row.name), Color: s(row.color), Event: s(row.event_name) };
}

/** Expects joined column: event_name. */
export function mapRoom(row: Row): Fields {
  return { Name: s(row.name), Capacity: n(row.capacity), Notes: s(row.notes), Event: s(row.event_name) };
}

/** Expects joined column: event_name. */
export function mapTag(row: Row): Fields {
  return { Name: s(row.name), Color: s(row.color), Event: s(row.event_name) };
}

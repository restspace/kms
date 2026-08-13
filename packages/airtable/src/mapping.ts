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
    // rating_normalized (sync.ts's selectSql) is the scale-aware mean —
    // averageRating over the raw rating_cache stays as a fallback for a
    // caller/test that queries submissions without that computed column.
    Rating: roundRating(n(row.rating_normalized)) ?? averageRating(row.rating_cache),
    Notes: s(row.notes),
    Event: s(row.event_name),
  };
}

const roundRating = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

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

// ---------------------------------------------------------------------------
// Second wave (migration 0045): the per-event speaker profile, the outbound
// mail log, review discussion, the sourcing pipeline, uploaded files and portal
// responses. Same rules as above — display names not ids, no JSON blobs left
// raw, no derived caches (event_contacts' participant counts, message bodies).
// ---------------------------------------------------------------------------

/** Expects joined columns: event_name, contact_name, contact_email. */
export function mapEventContact(row: Row): Fields {
  return {
    Name: s(row.contact_name),
    Email: s(row.contact_email),
    Event: s(row.event_name),
    Company: s(row.company),
    'Job Title': s(row.job_title),
    Biography: s(row.biography),
    Notes: s(row.notes),
    'Speaker Status': s(row.speaker_status),
    'Arrived At': s(row.arrived_at),
    Source: s(row.source),
    'Added At': s(row.added_at),
    'Prior Rating': n(row.prior_rating),
    'Prior Rating Note': s(row.prior_rating_note),
  };
}

/**
 * Expects joined columns: event_name, contact_name.
 *
 * body_html/body_text are deliberately not mirrored: the rendered message is
 * large, repeated per recipient, and it is the delivery record an organiser
 * wants in a spreadsheet, not the copy.
 */
export function mapMessage(row: Row): Fields {
  return {
    To: s(row.to_email),
    Subject: s(row.subject),
    Template: s(row.template_key),
    Status: s(row.status),
    Error: s(row.error),
    Contact: s(row.contact_name),
    Event: s(row.event_name),
    'Created At': s(row.created_at),
    'Sent At': s(row.sent_at),
  };
}

/** Expects joined columns: submission_code, submission_title, event_name, author_fallback_name. */
export function mapComment(row: Row): Fields {
  return {
    Submission: s(row.submission_code) ?? s(row.submission_title),
    'Submission Title': s(row.submission_title),
    // author_name is denormalised at write time; the join is the fallback for
    // rows (the 0018 backfill's included) that were written without it.
    Author: s(row.author_name) ?? s(row.author_fallback_name),
    Role: s(row.author_role),
    Kind: s(row.kind),
    Body: s(row.body),
    Event: s(row.event_name),
    'Created At': s(row.created_at),
  };
}

/**
 * Expects joined columns: contact_name, contact_email.
 *
 * No Event column — the pipeline is org-wide (a prospect is enrolled before
 * anyone knows which event they will speak at), unlike every table above.
 */
export function mapPipelineCard(row: Row): Fields {
  return {
    Contact: s(row.contact_name),
    Email: s(row.contact_email),
    Stage: s(row.stage),
    Score: n(row.score),
    Rationale: s(row.rationale),
    'Created At': s(row.created_at),
    'Updated At': s(row.updated_at),
  };
}

/** Expects joined columns: contact_name, contact_email. */
export function mapPipelineActivity(row: Row): Fields {
  return {
    Contact: s(row.contact_name),
    Email: s(row.contact_email),
    Kind: s(row.kind),
    'From Stage': s(row.from_stage),
    'To Stage': s(row.to_stage),
    Body: s(row.body),
    Author: s(row.author_name),
    'Created At': s(row.created_at),
  };
}

/** Expects joined columns: event_name, uploader_name, request_title. */
export function mapFile(row: Row): Fields {
  return {
    Filename: s(row.filename),
    'Content Type': s(row.content_type),
    'Size KB': kilobytes(row.size_bytes),
    'Uploaded By': s(row.uploader_name),
    Request: s(row.request_title),
    Event: s(row.event_name),
    'Created At': s(row.created_at),
  };
}

/** Bytes are unreadable in a spreadsheet column; KB to one place is not. */
const kilobytes = (bytes: unknown): number | null =>
  typeof bytes === 'number' ? Math.round((bytes / 1024) * 10) / 10 : null;

/** Expects joined column: event_name. */
export function mapFileRequest(row: Row): Fields {
  return {
    Title: s(row.title),
    Type: s(row.type),
    Instructions: s(row.instructions),
    'Due At': s(row.due_at),
    'Max Size MB': n(row.max_size_mb),
    Event: s(row.event_name),
  };
}

/** Expects joined columns: form_name, form_questions, contact_name, contact_email, submission_title, event_name. */
export function mapPortalResponse(row: Row): Fields {
  return {
    Form: s(row.form_name),
    Contact: s(row.contact_name),
    Email: s(row.contact_email),
    Submission: s(row.submission_title),
    Answers: renderAnswers(row.answers, row.form_questions),
    'Submitted At': s(row.submitted_at),
    Event: s(row.event_name),
  };
}

/**
 * `answers` is `{ "<question id>": "<value>" }` and the ids are uuids, so the
 * raw JSON is unreadable in a cell. Render one `Label: value` line per answer,
 * in the form's own question order, falling back to the bare id for an answer
 * whose question has since been deleted from the form.
 */
export function renderAnswers(answers: unknown, questions: unknown): string | null {
  if (typeof answers !== 'string' || answers === '') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(answers) as Record<string, unknown>;
  } catch {
    return null;
  }

  const labels = new Map<string, string>();
  if (typeof questions === 'string' && questions !== '') {
    try {
      const list = JSON.parse(questions) as Array<{ id?: unknown; label?: unknown }>;
      if (Array.isArray(list)) {
        for (const q of list) {
          if (typeof q?.id === 'string' && typeof q.label === 'string') labels.set(q.id, q.label);
        }
      }
    } catch {
      // fall through: ids as labels beats dropping the answers
    }
  }

  const ordered = [...labels.keys()].filter((id) => id in parsed);
  const rest = Object.keys(parsed).filter((id) => !labels.has(id));
  const lines = [...ordered, ...rest].map((id) => `${labels.get(id) ?? id}: ${String(parsed[id] ?? '')}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

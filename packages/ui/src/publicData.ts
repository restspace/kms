// Shared data-access module for the public event pages (sessions, speakers,
// agenda, schedule, gallery widgets). One `fetch` wrapper + one set of types
// per feed, so every widget lane reads the same shapes off the same two
// endpoints (apps/api/src/routes/landing.ts):
//   GET /e/:slug/agenda.json    — published sessions, rooms, tracks, days
//   GET /e/:slug/speakers.json  — published speaker directory
//
// Both feeds 404 with { error: 'not_found' } until the organiser flips
// `agenda_published`; `fetchAgenda`/`fetchSpeakers` surface that as `null`
// rather than throwing, so a widget can render a "not published yet" state
// without a try/catch of its own.

export interface PublicEvent {
  name: string;
  slug: string;
  timezone: string;
  /**
   * Event date range (UTC instants), additive (landing.tsx, EMB-07): lets a
   * widget derive the full list of event days — including days with no
   * sessions yet — instead of only the days a session happens to land on.
   * Null on a feed from before this field existed / an event with no dates.
   */
  starts_at?: string | null;
  ends_at?: string | null;
}

export interface PublicRoom {
  id: string;
  name: string;
  capacity: number | null;
}

export interface PublicTrack {
  id: string;
  name: string;
  color: string | null;
}

export interface PublicSessionSpeaker {
  id: string;
  name: string;
  title: string | null;
  company: string | null;
}

export interface PublicSession {
  id: string;
  code: string;
  title: string;
  description: string | null;
  format: string | null;
  level: string | null;
  capacity: number | null;
  track_id: string | null;
  room_id: string | null;
  starts_at: string;
  ends_at: string;
  /** YYYY-MM-DD in the event's own timezone (docs/07 §8). */
  day: string;
  /** Display names only — never emails (public payload, PII-redacted). */
  speakers: string[];
  /**
   * EMB-01: same speakers as `speakers`, with title/company for the card
   * (nullable — never emails/phones, same PII boundary as speakers.json).
   * Additive alongside `speakers` (kept as plain names) so consumers still
   * reading the string-array shape are unaffected.
   */
  speaker_details: PublicSessionSpeaker[];
}

export interface AgendaFeed {
  event: PublicEvent;
  days: string[];
  rooms: PublicRoom[];
  tracks: PublicTrack[];
  sessions: PublicSession[];
}

export interface PublicSpeakerSession {
  id: string;
  title: string;
  /**
   * Additive (EMB-05/EMB-13): lets the speaker detail page and gallery modal
   * show each session's event-local date/time and room instead of just a
   * bare title. Optional/nullable so an older cached feed still parses.
   */
  starts_at?: string;
  ends_at?: string;
  /** YYYY-MM-DD in the event's own timezone, same convention as PublicSession.day. */
  day?: string;
  room?: string | null;
}

export interface PublicSpeaker {
  id: string;
  name: string;
  title: string | null;
  company: string | null;
  bio: string | null;
  /** Always null until a public-safe asset route exists (see landing.ts). */
  headshot_url: string | null;
  sessions: PublicSpeakerSession[];
}

export interface SpeakersFeed {
  event: PublicEvent;
  /** Sorted by surname, then full name, server-side. */
  speakers: PublicSpeaker[];
}

/** Base path for a slug's feeds — kept in one place so a URL-shape change is a one-line edit. */
export function agendaJsonUrl(slug: string): string {
  return `/e/${encodeURIComponent(slug)}/agenda.json`;
}

export function speakersJsonUrl(slug: string): string {
  return `/e/${encodeURIComponent(slug)}/speakers.json`;
}

/**
 * The Sessions list widget's own feed URL (EMB-15): same payload shape as
 * agenda.json (see landing.tsx's `loadAgendaFeed`), under a URL that names
 * what it is rather than the agenda grid it happens to share data with.
 * Not used by SessionsWidget itself (which reads `fetchAgenda`, since the
 * shape it needs — rooms/tracks for facets — is the agenda shape) — this
 * exists for the embed builder to hand out.
 */
export function sessionsJsonUrl(slug: string): string {
  return `/e/${encodeURIComponent(slug)}/sessions.json`;
}

export function agendaIcsUrl(slug: string): string {
  return `/e/${encodeURIComponent(slug)}/agenda.ics`;
}

/** null on 404 (not yet published) or any network/parse failure; throws on nothing. */
export async function fetchAgenda(slug: string): Promise<AgendaFeed | null> {
  try {
    const res = await fetch(agendaJsonUrl(slug));
    if (!res.ok) return null;
    return (await res.json()) as AgendaFeed;
  } catch {
    return null;
  }
}

export async function fetchSpeakers(slug: string): Promise<SpeakersFeed | null> {
  try {
    const res = await fetch(speakersJsonUrl(slug));
    if (!res.ok) return null;
    return (await res.json()) as SpeakersFeed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embed/deep-link filters (lane W3-A, rubric EMB-15).
//
// The public pages accept `?track=` and `?day=` so an organiser can embed or
// link a *slice* of the agenda ("just the Platform track", "just day two").
// The feeds themselves are unchanged: filtering happens here, over the fetched
// payload, so every widget applies the same rule and no widget needs its own
// query-param handling. `track` matches a track id or a track name
// (case-insensitive) — ids are opaque, names are what an organiser types.
// ---------------------------------------------------------------------------

export interface PublicFeedFilter {
  /** Track id, (case-insensitive) track name, or track name slug. */
  track?: string | null;
  /** Day key, YYYY-MM-DD in the event timezone. */
  day?: string | null;
}

/**
 * Readable URL form of a track name — "Platform Engineering" →
 * "platform-engineering". Generated links use this instead of the opaque
 * track UUID; the read side (this filter, plus the XML feeds server-side)
 * accepts id, name and slug alike, so old UUID links keep working.
 */
export function trackSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** True when the filter would change nothing. */
export function isEmptyFilter(filter: PublicFeedFilter | null | undefined): boolean {
  return !filter || (!filter.track && !filter.day);
}

/**
 * Empty-state copy for a widget whose embed filter matched nothing (eval
 * defect: a sessions embed with `?track=` said "No sessions are scheduled
 * yet." when the agenda was full and the FILTER simply matched no session —
 * a visitor could conclude the agenda is empty). Names the active filter,
 * resolving the track back to its display name against the UNFILTERED feed's
 * track list (applyFeedFilter strips unmatched tracks from its output, so
 * callers must pass the raw feed's tracks).
 */
export function filteredEmptyMessage(
  tracks: PublicTrack[] | undefined,
  filter: PublicFeedFilter | null | undefined,
): string {
  const parts: string[] = [];
  const wanted = (filter?.track ?? '').trim();
  if (wanted) {
    const lower = wanted.toLowerCase();
    const wantedSlug = trackSlug(wanted);
    const match = (tracks ?? []).find(
      (t) => t.id.toLowerCase() === lower || (wantedSlug !== '' && trackSlug(t.name ?? '') === wantedSlug),
    );
    parts.push(`the "${match?.name ?? wanted}" track`);
  }
  const day = (filter?.day ?? '').trim();
  if (day) parts.push(day);
  return parts.length > 0
    ? `No sessions match the selected filter (${parts.join(', ')}).`
    : 'No sessions match the selected filter.';
}

// ---------------------------------------------------------------------------
// Field-visibility toggles (workplan 14, F3/D6): the SSR handler
// (apps/api/src/routes/landing.tsx parsePageOptions) parses
// ?show_abstract=0 / ?show_speakers=0 / ?show_room=0 / ?show_track=0 off the
// query string and rides them through EventPageOptions exactly like `filter`
// does. Every field defaults to shown (true) — the object is only non-empty
// when at least one flag was explicitly turned off, so a bare public page
// carries no `show` at all and every widget's default read (`fieldVisible`)
// resolves to true.
// ---------------------------------------------------------------------------

export interface FieldVisibility {
  /** Session description / abstract text. Default true. */
  abstract?: boolean;
  /** Speaker line (including the "Speaker TBA" placeholder). Default true. */
  speakers?: boolean;
  /** Room name/chip. Default true. */
  room?: boolean;
  /** Track name/chip/badge. Default true. */
  track?: boolean;
}

/** Only `false` hides a field — absent/undefined means "shown" (the default). */
export function fieldVisible(show: FieldVisibility | undefined, key: keyof FieldVisibility): boolean {
  return show?.[key] !== false;
}

/**
 * Narrow a feed to the sessions a filter selects, recomputing `days` and
 * `tracks` so the widgets' day tabs and track facets only offer what survives.
 * Returns the input untouched for an empty filter (and passes `null` through,
 * so a widget can pipe `fetchAgenda(...)` straight into it).
 */
export function applyFeedFilter(
  feed: AgendaFeed | null,
  filter?: PublicFeedFilter | null,
): AgendaFeed | null {
  if (!feed || isEmptyFilter(filter)) return feed;
  const wanted = (filter?.track ?? '').trim().toLowerCase();
  // Slugifying both sides makes name matching case/whitespace/punctuation
  // insensitive and, in the same stroke, accepts the readable slugs the embed
  // builder now generates ("platform-engineering" ⇄ "Platform Engineering").
  const wantedSlug = trackSlug(wanted);
  const trackIds = new Set(
    feed.tracks
      .filter((t) => t.id.toLowerCase() === wanted || (wantedSlug !== '' && trackSlug(t.name ?? '') === wantedSlug))
      .map((t) => t.id),
  );
  const day = (filter?.day ?? '').trim();

  const sessions = feed.sessions.filter((s) => {
    if (wanted && !(s.track_id !== null && trackIds.has(s.track_id))) return false;
    if (day && s.day !== day) return false;
    return true;
  });

  const keptDays = new Set(sessions.map((s) => s.day));
  const keptTracks = new Set(sessions.map((s) => s.track_id).filter((id): id is string => id !== null));
  return {
    ...feed,
    days: feed.days.filter((d) => keptDays.has(d)),
    tracks: feed.tracks.filter((t) => keptTracks.has(t.id)),
    sessions,
  };
}

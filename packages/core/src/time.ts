/**
 * Calendar-day helpers keyed to an event's timezone rather than the server's.
 *
 * "Once per day" in this product means once per day *where the event is*
 * (NFR-12, the same rule that makes an admin-typed datetime event-local
 * rather than viewer-local). Deriving it from a UTC instant instead is wrong
 * by up to a day at the edges: an organiser in America/Los_Angeles pressing
 * "Remind all" at 17:00 is already on the next UTC date, so a UTC-keyed
 * guard would treat a second press minutes later as a different day and let
 * the reminder through.
 */

/** UTC instant → `YYYY-MM-DD` as read off a wall clock in `timeZone`. */
export function eventLocalDay(isoUtc: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, so the parts come out already zero-padded
  // and in order; formatToParts avoids depending on that for the join.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoUtc));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

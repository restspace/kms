/**
 * Wave E (workplan 14, D8): the non-submission flavours of the content-history
 * section — contact profile fields on the speaker detail panel, event settings
 * on the Settings hub. Both are thin configs over the same
 * `ContentHistorySection` the submission panel uses (one history UI for every
 * entity type), and both restore by writing the snapshot back through the
 * entity's NORMAL update surface, which snapshots the replaced values itself.
 *
 * Kept in its own module (rather than extras.tsx) so extras.tsx's api imports
 * stay untouched — several tests mock '../api' with an explicit export list
 * keyed to what extras imports.
 */
import { useMemo } from 'react'
import { getContactRevisions, getEventRevisions, patchEvent, updateContact } from '../api'
import { ContentHistorySection, type EntityHistoryConfig } from './extras'

/** Profile history for one event_contacts row. `eventId` must be the row's
 * own event (the grid spans events) — the same event the PUT writes. */
export function ContactProfileHistory({
  contactId,
  eventId,
  onRestored,
}: {
  contactId: string
  eventId: string | null | undefined
  /** Called with the restored fields so the host panel can refresh its row. */
  onRestored?: (fields: Record<string, string | null>) => void | Promise<void>
}) {
  const cfg = useMemo<EntityHistoryConfig>(
    () => ({
      cacheKey: `contact:${eventId ?? ''}:${contactId}`,
      load: () => getContactRevisions(contactId, eventId).then((r) => r.items),
      // event_id routes the write to the row's own event_contacts row — the
      // same targeting the contacts PUT applies to an ordinary edit.
      restore: (fields) =>
        updateContact(contactId, { ...fields, ...(eventId ? { event_id: eventId } : {}) }).then(() => undefined),
      fieldLabels: [
        ['biography', 'Biography'],
        ['company', 'Company'],
        ['job_title', 'Job title'],
      ],
      noun: 'the biography, company and job title',
      emptyText: 'No profile edits recorded — the biography, company and job title are as first entered.',
    }),
    [contactId, eventId],
  )
  return <ContentHistorySection entity={cfg} onRestored={onRestored} />
}

/** Settings history for the current event (mounted on the Settings hub). */
export function EventSettingsHistory({ eventId }: { eventId: string }) {
  const cfg = useMemo<EntityHistoryConfig>(
    () => ({
      cacheKey: `settings:${eventId}`,
      load: () => getEventRevisions(eventId).then((r) => r.items),
      // The snapshot's keys are the PATCH surface's own field names
      // (description, not the storage column), so it round-trips directly.
      restore: (fields) => patchEvent(eventId, fields).then(() => undefined),
      fieldLabels: [
        ['name', 'Name'],
        ['slug', 'Slug'],
        ['type', 'Type'],
        ['website_url', 'Website'],
        ['location', 'Location'],
        ['timezone', 'Timezone'],
        ['description', 'Description'],
        ['starts_at', 'Starts'],
        ['ends_at', 'Ends'],
      ],
      noun: 'the event settings',
      emptyText: 'No settings edits recorded — the event settings are as first configured.',
    }),
    [eventId],
  )
  return <ContentHistorySection entity={cfg} />
}

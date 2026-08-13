/**
 * Eval defects #2/#4/#5/#16 (2026-08-13 run): the speaker edit form's
 * "hydrate from the persisted record / never clobber what you didn't render"
 * contract, pinned as pure logic — same pattern as
 * App.speakersHygiene.logic.test.ts.
 *
 *  - buildSpeakerFormSchema: Status is a real field on create/edit (#5/#16),
 *    with the event's custom speaker_status options and custom contact fields
 *    folded in.
 *  - buildSpeakerSavePayload: the save narrows to the fields the form
 *    rendered, so stale row keys can never overwrite untouched columns (#2),
 *    and an empty status is omitted (absent = unchanged server-side) rather
 *    than sent as a clearing null.
 *  - hydrateContactRow: a raw server row gains BOTH flat-key families
 *    (cf__<key> and link_*) so re-seeding the edit form after a save or a
 *    ?rec= deep link shows the persisted values (#4).
 */
import { describe, expect, it } from 'vitest'
import type { ContactFieldDef, ContactRow, SpeakerStatusOption } from './api'
import { buildSpeakerFormSchema, buildSpeakerSavePayload, hydrateContactRow } from './App'

const customStatus: SpeakerStatusOption = {
  id: 'sso-1',
  event_id: 'evt-1',
  key: 'keynote_hold',
  label: 'Keynote hold',
  position: 0,
}

const speakerTypeField: ContactFieldDef = {
  id: 'cfd-1',
  event_id: 'evt-1',
  key: 'speaker_type',
  label: 'Speaker Type',
  type: 'select',
  options: JSON.stringify(['Internal', 'External']),
  position: 0,
} as unknown as ContactFieldDef

const row = {
  id: 'c-priya',
  event_id: 'evt-1',
  event_name: 'DevFlow Conf 2027',
  email: 'priya@example.com',
  first_name: 'Priya',
  last_name: 'Raman',
  company: 'Acme',
  job_title: 'CTO',
  mobile_phone: null,
  biography: null,
  pronouns: null,
  headshot_asset_id: null,
  notes: null,
  links: JSON.stringify({ linkedin: 'https://linkedin.com/in/priya', twitter: 'https://x.com/priya' }),
  custom_fields_json: JSON.stringify({ speaker_type: 'External' }),
  speaker_status: 'confirmed',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
} as unknown as ContactRow

describe('buildSpeakerFormSchema', () => {
  it('renders speaker_status as an enum field with built-in and custom options, labels included', () => {
    const schema = buildSpeakerFormSchema([customStatus], [])
    const status = schema.properties.speaker_status
    expect(status).toBeTruthy()
    expect(status.enum).toEqual(['prospect', 'invited', 'awaiting_reply', 'confirmed', 'declined', 'keynote_hold'])
    expect(status.enumNames).toEqual([
      'Prospect',
      'Invited',
      'Awaiting reply',
      'Confirmed',
      'Declined',
      'Keynote hold',
    ])
  })

  it('does not duplicate a custom option that shadows a built-in key', () => {
    const shadowing = { ...customStatus, key: 'confirmed', label: 'Confirmed (custom)' }
    const schema = buildSpeakerFormSchema([shadowing], [])
    const keys = schema.properties.speaker_status.enum as string[]
    expect(keys.filter((k) => k === 'confirmed')).toHaveLength(1)
  })

  it('includes the event custom fields as cf__ properties (defect #5: Speaker Type select)', () => {
    const schema = buildSpeakerFormSchema([], [speakerTypeField])
    const prop = schema.properties.cf__speaker_type
    expect(prop).toBeTruthy()
    expect(prop.title).toBe('Speaker Type')
    expect(prop.enum).toEqual(['Internal', 'External'])
  })
})

describe('buildSpeakerSavePayload', () => {
  const schema = buildSpeakerFormSchema([customStatus], [speakerTypeField])

  it('narrows the whole-record submit to the fields the form rendered (defect #2)', () => {
    const data = { ...hydrateContactRow(row, [speakerTypeField]), notes: 'Call re: AV' } as unknown as Record<
      string,
      unknown
    >
    const payload = buildSpeakerSavePayload(data, schema, [speakerTypeField])
    // Rendered fields travel…
    expect(payload.notes).toBe('Call re: AV')
    expect(payload.first_name).toBe('Priya')
    expect(payload.speaker_status).toBe('confirmed')
    // …stale row-only keys do not (the API would treat some as writes).
    expect('event_name' in payload).toBe(false)
    expect('created_at' in payload).toBe(false)
    expect('custom_fields_json' in payload).toBe(false)
    expect('headshot_asset_id' in payload).toBe(false)
  })

  it('omits an empty speaker_status instead of sending a clearing null', () => {
    const payload = buildSpeakerSavePayload(
      { first_name: 'Priya', speaker_status: null },
      schema,
      [],
    )
    expect('speaker_status' in payload).toBe(false)
    const payload2 = buildSpeakerSavePayload({ first_name: 'Priya' }, schema, [])
    expect('speaker_status' in payload2).toBe(false)
  })

  it('re-nests link_* and cf__* into the links/custom_fields shapes the API expects', () => {
    const payload = buildSpeakerSavePayload(
      {
        email: 'priya@example.com',
        link_linkedin: 'https://linkedin.com/in/priya',
        link_twitter: '@priya',
        cf__speaker_type: 'Internal',
      },
      schema,
      [speakerTypeField],
    )
    expect(payload.links).toEqual({
      linkedin: 'https://linkedin.com/in/priya',
      twitter: 'https://x.com/priya',
    })
    expect(payload.custom_fields).toEqual({ speaker_type: 'Internal' })
    expect('link_linkedin' in payload).toBe(false)
    expect('cf__speaker_type' in payload).toBe(false)
  })

  it('leaves links untouched when the form was seeded without link keys (no wipe on save)', () => {
    const payload = buildSpeakerSavePayload({ email: 'priya@example.com', notes: 'x' }, schema, [])
    expect('links' in payload).toBe(false)
  })
})

describe('hydrateContactRow', () => {
  it('attaches both cf__ and link_* flat keys to a raw server row (defect #4)', () => {
    const hydrated = hydrateContactRow(row, [speakerTypeField]) as unknown as Record<string, unknown>
    expect(hydrated.link_linkedin).toBe('https://linkedin.com/in/priya')
    expect(hydrated.link_twitter).toBe('https://x.com/priya')
    expect(hydrated.link_facebook).toBe('')
    expect(hydrated.cf__speaker_type).toBe('External')
    // The raw columns survive for the detail panel's own rendering.
    expect(hydrated.links).toBe(row.links)
    expect(hydrated.speaker_status).toBe('confirmed')
  })
})

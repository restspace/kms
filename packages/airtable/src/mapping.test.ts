import { describe, expect, it } from 'vitest';
import {
  averageRating,
  mapContact,
  mapEvent,
  mapReview,
  mapRoom,
  mapSubmission,
  mapTag,
  mapTask,
  mapTrack,
} from './mapping';

describe('mapSubmission', () => {
  it('maps a representative joined row to spreadsheet fields', () => {
    expect(
      mapSubmission({
        code: 'S-042',
        title: 'Talk',
        kind: 'session',
        status: 'accepted',
        description: 'Desc',
        format: 'talk',
        level: 'intro',
        language: 'en',
        track_name: 'AI',
        room_name: 'Main',
        starts_at: '2026-10-12T09:00:00Z',
        ends_at: '2026-10-12T10:00:00Z',
        capacity: 120,
        speaker_name: 'Ada Lovelace',
        speaker_email: 'ada@example.com',
        rating_cache: '{"plan-1": 4, "plan-2": 5}',
        notes: 'internal note',
        event_name: 'DevConf',
      }),
    ).toEqual({
      Code: 'S-042',
      Title: 'Talk',
      Kind: 'session',
      Status: 'accepted',
      Description: 'Desc',
      Format: 'talk',
      Level: 'intro',
      Language: 'en',
      Track: 'AI',
      Room: 'Main',
      'Starts At': '2026-10-12T09:00:00Z',
      'Ends At': '2026-10-12T10:00:00Z',
      Capacity: 120,
      Speaker: 'Ada Lovelace',
      'Speaker Email': 'ada@example.com',
      Rating: 4.5,
      Notes: 'internal note',
      Event: 'DevConf',
    });
  });

  it('maps nulls and empty strings to explicit null so cleared values clear in Airtable', () => {
    const fields = mapSubmission({ code: 'S-1', title: 'T', status: 'draft', description: '', track_name: null });
    expect(fields.Description).toBeNull();
    expect(fields.Track).toBeNull();
    expect(fields.Room).toBeNull();
    expect(fields.Capacity).toBeNull();
    expect(fields.Rating).toBeNull();
  });
});

describe('averageRating', () => {
  it('averages across plans, rounded to 2dp', () => {
    expect(averageRating('{"a": 4.333, "b": 3}')).toBe(3.67);
  });
  it('returns null for null, empty, invalid json and empty object', () => {
    expect(averageRating(null)).toBeNull();
    expect(averageRating('')).toBeNull();
    expect(averageRating('not json')).toBeNull();
    expect(averageRating('{}')).toBeNull();
  });
});

describe('mapContact', () => {
  it('flattens the links json into per-network fields', () => {
    const fields = mapContact({
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      links: '{"linkedin": "https://li.example", "website": "https://ada.example"}',
    });
    expect(fields).toMatchObject({
      Email: 'ada@example.com',
      'First Name': 'Ada',
      'Last Name': 'Lovelace',
      LinkedIn: 'https://li.example',
      Twitter: null,
      Website: 'https://ada.example',
    });
  });

  it('tolerates malformed links json', () => {
    const fields = mapContact({ email: 'x@example.com', links: '{oops' });
    expect(fields.LinkedIn).toBeNull();
    expect(fields.Website).toBeNull();
  });
});

describe('remaining mappers', () => {
  it('mapEvent converts the 0/1 agenda_published to a boolean', () => {
    const fields = mapEvent({ name: 'DevConf', slug: 'devconf', agenda_published: 1 });
    expect(fields.Name).toBe('DevConf');
    expect(fields['Agenda Published']).toBe(true);
  });

  it('mapTask maps action_type and 0/1 required', () => {
    const fields = mapTask({ title: 'Upload slides', action_type: 'file_upload', required: 0, event_name: 'DevConf' });
    expect(fields).toMatchObject({ Title: 'Upload slides', Action: 'file_upload', Required: false, Event: 'DevConf' });
  });

  it('mapReview falls back to the submission title when there is no code', () => {
    const fields = mapReview({
      submission_code: null,
      submission_title: 'Talk',
      reviewer_name: 'Ada Lovelace',
      reviewer_email: 'ada@example.com',
      weighted_total: 4.2,
      conflict_of_interest: 1,
      event_name: 'DevConf',
    });
    expect(fields.Submission).toBe('Talk');
    expect(fields.Total).toBe(4.2);
    expect(fields['Conflict Of Interest']).toBe(true);
  });

  it('mapTrack/mapRoom/mapTag carry the event name for base-side filtering', () => {
    expect(mapTrack({ name: 'AI', color: '#f00', event_name: 'DevConf' })).toEqual({
      Name: 'AI',
      Color: '#f00',
      Event: 'DevConf',
    });
    expect(mapRoom({ name: 'Main', capacity: 300, notes: null, event_name: 'DevConf' })).toEqual({
      Name: 'Main',
      Capacity: 300,
      Notes: null,
      Event: 'DevConf',
    });
    expect(mapTag({ name: 'keynote', color: null, event_name: 'DevConf' })).toEqual({
      Name: 'keynote',
      Color: null,
      Event: 'DevConf',
    });
  });
});

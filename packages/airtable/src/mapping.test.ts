import { describe, expect, it } from 'vitest';
import {
  averageRating,
  mapComment,
  mapContact,
  mapEvent,
  mapEventContact,
  mapFile,
  mapMessage,
  mapPipelineCard,
  mapPortalResponse,
  mapReview,
  mapRoom,
  mapSubmission,
  mapTag,
  mapTask,
  mapTrack,
  renderAnswers,
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

  // ABS-01 rating normalization: sync.ts's selectSql computes rating_normalized
  // (a scale-aware mean across plans, unlike the raw rating_cache average) —
  // it must win over the averageRating(rating_cache) fallback when present.
  it('prefers the normalized rating column over the raw rating_cache average', () => {
    const fields = mapSubmission({
      code: 'S-042',
      title: 'Talk',
      status: 'accepted',
      // A raw average of these would be 6.5 (pooling a 1-5 round with a
      // 0-10 round as if they were the same unit); the normalized column is
      // what the query actually produces and must be used instead.
      rating_cache: '{"plan-1": 4, "plan-2": 9}',
      rating_normalized: 4.25,
    });
    expect(fields.Rating).toBe(4.25);
  });

  it('falls back to averageRating(rating_cache) when rating_normalized is absent (e.g. a hand-built row)', () => {
    const fields = mapSubmission({
      code: 'S-042',
      title: 'Talk',
      status: 'accepted',
      rating_cache: '{"plan-1": 4, "plan-2": 5}',
    });
    expect(fields.Rating).toBe(4.5);
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

// Second wave (migration 0045).
describe('mapEventContact', () => {
  it('carries the per-event speaker profile, with the contact resolved to a name', () => {
    expect(
      mapEventContact({
        contact_name: 'Ada Lovelace',
        contact_email: 'ada@example.com',
        event_name: 'DevConf',
        company: 'Analytical Engines',
        job_title: 'Principal',
        biography: 'Bio',
        speaker_status: 'confirmed',
        arrived_at: '2026-10-12T08:40:00Z',
        source: 'cfp',
        added_at: '2026-06-01T00:00:00Z',
        prior_rating: 4.4,
      }),
    ).toMatchObject({
      Name: 'Ada Lovelace',
      Email: 'ada@example.com',
      Event: 'DevConf',
      Company: 'Analytical Engines',
      'Speaker Status': 'confirmed',
      'Arrived At': '2026-10-12T08:40:00Z',
      'Prior Rating': 4.4,
      'Prior Rating Note': null,
    });
  });
});

describe('mapMessage', () => {
  it('maps the delivery record and leaves the rendered body out of it', () => {
    const fields = mapMessage({
      to_email: 'ada@example.com',
      subject: 'You are accepted',
      template_key: 'decision_accept',
      status: 'sent',
      contact_name: 'Ada Lovelace',
      event_name: 'DevConf',
      created_at: '2026-08-01T10:00:00Z',
      sent_at: '2026-08-01T10:00:03Z',
      body_html: '<p>huge</p>',
    });
    expect(fields).toEqual({
      To: 'ada@example.com',
      Subject: 'You are accepted',
      Template: 'decision_accept',
      Status: 'sent',
      Error: null,
      Contact: 'Ada Lovelace',
      Event: 'DevConf',
      'Created At': '2026-08-01T10:00:00Z',
      'Sent At': '2026-08-01T10:00:03Z',
    });
  });
});

describe('mapComment', () => {
  it('prefers the denormalised author name and falls back to the joined contact', () => {
    expect(mapComment({ author_name: 'Ada', author_fallback_name: 'Someone Else' }).Author).toBe('Ada');
    expect(mapComment({ author_name: null, author_fallback_name: 'Grace Hopper' }).Author).toBe('Grace Hopper');
  });

  it('labels the row by submission code, falling back to the title', () => {
    expect(mapComment({ submission_code: 'S-042', submission_title: 'Talk' }).Submission).toBe('S-042');
    expect(mapComment({ submission_code: null, submission_title: 'Talk' }).Submission).toBe('Talk');
  });
});

describe('mapPipelineCard', () => {
  it('has no Event column — the pipeline is org-wide', () => {
    const fields = mapPipelineCard({ contact_name: 'Ada', contact_email: 'ada@example.com', stage: 'interested' });
    expect(Object.keys(fields)).not.toContain('Event');
    expect(fields).toMatchObject({ Contact: 'Ada', Stage: 'interested', Score: null });
  });
});

describe('mapFile', () => {
  it('reports size in KB rather than bytes, and names the request it answered', () => {
    expect(
      mapFile({
        filename: 'slides.pdf',
        content_type: 'application/pdf',
        size_bytes: 2_411_724,
        uploader_name: 'Ada Lovelace',
        request_title: 'Final slides',
        event_name: 'DevConf',
        created_at: '2026-10-01T09:00:00Z',
      }),
    ).toEqual({
      Filename: 'slides.pdf',
      'Content Type': 'application/pdf',
      'Size KB': 2355.2,
      'Uploaded By': 'Ada Lovelace',
      Request: 'Final slides',
      Event: 'DevConf',
      'Created At': '2026-10-01T09:00:00Z',
    });
    expect(mapFile({ filename: 'x.pdf' })['Size KB']).toBeNull();
  });
});

describe('mapPortalResponse / renderAnswers', () => {
  const questions = JSON.stringify([
    { id: 'q-diet', label: 'Dietary requirements' },
    { id: 'q-shirt', label: 'T-shirt size' },
  ]);

  it('renders answers as labelled lines in the form’s question order', () => {
    expect(renderAnswers(JSON.stringify({ 'q-shirt': 'L', 'q-diet': 'None' }), questions)).toBe(
      'Dietary requirements: None\nT-shirt size: L',
    );
  });

  it('falls back to the bare question id for an answer whose question is gone', () => {
    expect(renderAnswers(JSON.stringify({ 'q-removed': 'yes' }), questions)).toBe('q-removed: yes');
  });

  it('returns null for empty, absent and malformed answers', () => {
    expect(renderAnswers(null, questions)).toBeNull();
    expect(renderAnswers('', questions)).toBeNull();
    expect(renderAnswers('{oops', questions)).toBeNull();
    expect(renderAnswers('{}', questions)).toBeNull();
  });

  it('still renders when the form questions are unreadable', () => {
    expect(renderAnswers(JSON.stringify({ 'q-diet': 'None' }), '{oops')).toBe('q-diet: None');
  });

  it('maps the response with its form, contact and submission resolved', () => {
    expect(
      mapPortalResponse({
        form_name: 'Speaker details',
        form_questions: questions,
        contact_name: 'Ada Lovelace',
        contact_email: 'ada@example.com',
        submission_title: 'Talk',
        answers: JSON.stringify({ 'q-diet': 'None' }),
        submitted_at: '2026-08-01T10:00:00Z',
        event_name: 'DevConf',
      }),
    ).toMatchObject({
      Form: 'Speaker details',
      Contact: 'Ada Lovelace',
      Submission: 'Talk',
      Answers: 'Dietary requirements: None',
    });
  });
});

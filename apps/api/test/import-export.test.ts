// FR-REV-8 — CSV/XLSX import (parse → map → dry run → commit) and the files
// bundle ZIP. The rubric fixture is the contacts case: a sheet holding two
// speakers who already exist plus one new person (Dana Kowalski) must leave
// Dana in the roster and must not clobber the two existing records.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { autoMap, parseCsv, parseXlsx } from '../src/importer';
import { toXlsx } from '../src/export';

const ORIGIN = 'https://example.com';

const post = (path: string, cookie: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}/app/api${path}`, jsonReq(cookie, body, 'POST'));

const upload = (cookie: string, target: string, eventId: string, filename: string, content: string | Uint8Array) => {
  const form = new FormData();
  form.set('target', target);
  form.set('event_id', eventId);
  form.set('file', new File([content as BlobPart], filename));
  return SELF.fetch(`${ORIGIN}/app/api/import/preview`, { method: 'POST', headers: { cookie }, body: form });
};

interface PlanRow {
  row: number;
  action: string;
  message: string | null;
  label: string;
  errors: string[];
}
interface PlanBody {
  mapping: string[];
  headers: string[];
  rows: PlanRow[];
  rows_raw: string[][];
  summary: Record<string, number>;
  newTracks: string[];
  newRooms: string[];
  event_id: string;
}

// ---------------------------------------------------------------------------
// Pure parsing / mapping
// ---------------------------------------------------------------------------

describe('spreadsheet parsing', () => {
  it('parses quoted CSV with embedded commas, quotes and CRLF line ends', () => {
    const csv = '﻿Title,Description\r\n"Hello, world","He said ""hi"""\r\nPlain,Simple\r\n\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Title', 'Description'],
      ['Hello, world', 'He said "hi"'],
      ['Plain', 'Simple'],
    ]);
  });

  it('reads an XLSX workbook back out of the writer the exports use', () => {
    const bytes = toXlsx(
      [
        { Title: 'Opening Keynote', Room: 'Hall A', Capacity: 300 },
        { Title: 'Closing, Panel', Room: 'Hall B', Capacity: 120 },
      ],
      'Sessions',
    );
    expect(parseXlsx(bytes)).toEqual([
      ['Title', 'Room', 'Capacity'],
      ['Opening Keynote', 'Hall A', '300'],
      ['Closing, Panel', 'Hall B', '120'],
    ]);
  });

  it('auto-maps headers by name, preferring exact matches over containment', () => {
    expect(autoMap(['First Name', 'Last name', 'E-mail', 'Job Title', 'Employer', 'Zip'], 'contacts')).toEqual([
      'first_name',
      'last_name',
      'email',
      'job_title',
      'company',
      '',
    ]);
    expect(autoMap(['Session Title', 'Abstract', 'Track Name', 'Room', 'Session ID'], 'sessions')).toEqual([
      'title',
      'description',
      'track',
      'room',
      'client_session_id',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('session import', () => {
  const SHEET = [
    'Session ID,Title,Abstract,Format,Track,Room,Start',
    'ext-1,Opening Keynote,Why we are here,Keynote,Platform,Hall A,2026-10-01T09:00:00Z',
    'ext-2,Deep Dive,,Workshop,Platform,Hall A,',
    'ext-3,,No title here,,,,',
  ].join('\n');

  it('dry-runs create/update/error rows and reports the rooms and tracks it will create', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const res = await upload(admin.cookie, 'sessions', eventId, 'sessions.csv', SHEET);
    expect(res.status).toBe(200);
    const plan = (await res.json()) as PlanBody;

    expect(plan.mapping).toEqual(['client_session_id', 'title', 'description', 'format', 'track', 'room', 'starts_at']);
    expect(plan.rows.map((r) => r.action)).toEqual(['create', 'create', 'error']);
    expect(plan.rows[2].errors).toEqual(['Title is required']);
    expect(plan.summary).toMatchObject({ create: 2, error: 1, total: 3 });
    expect(plan.newTracks).toEqual(['Platform']);
    expect(plan.newRooms).toEqual(['Hall A']);

    // Dry run means dry: nothing was written.
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE event_id = ?')
      .bind(eventId)
      .first<{ n: number }>();
    expect(before?.n).toBe(0);
  });

  it('commits, allocating codes and resolving track/room names, then updates on a second pass', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const preview = (await (await upload(admin.cookie, 'sessions', eventId, 'sessions.csv', SHEET)).json()) as PlanBody;
    const commit = await post('/import/commit', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      headers: preview.headers,
      rows: preview.rows_raw,
      mapping: preview.mapping,
    });
    expect(commit.status).toBe(200);
    expect((await commit.json()) as { applied: Record<string, number> }).toMatchObject({
      applied: { create: 2, error: 1, total: 3 },
    });

    const { results } = await env.DB.prepare(
      `SELECT s.code, s.title, s.status, s.client_session_id, s.source, s.starts_at,
              t.name AS track_name, r.name AS room_name
       FROM submissions s
       LEFT JOIN tracks t ON t.id = s.track_id
       LEFT JOIN rooms r ON r.id = s.room_id
       WHERE s.event_id = ? ORDER BY s.client_session_id`,
    )
      .bind(eventId)
      .all<Record<string, string | null>>();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      code: 'SESS-1',
      title: 'Opening Keynote',
      client_session_id: 'ext-1',
      source: 'import',
      track_name: 'Platform',
      room_name: 'Hall A',
      // A row that carries a time is scheduled content, so it lands accepted;
      // a row without one is a pending abstract.
      status: 'accepted',
    });
    expect(results[1]).toMatchObject({ code: 'SESS-2', title: 'Deep Dive', status: 'pending', room_name: 'Hall A' });
    // Both rows named the same track/room, which must be created exactly once.
    const tracks = await env.DB.prepare('SELECT COUNT(*) AS n FROM tracks WHERE event_id = ?').bind(eventId).first<{ n: number }>();
    expect(tracks?.n).toBe(1);

    // Second pass: same Session IDs, changed titles → updates, not duplicates.
    const second = [
      'Session ID,Title',
      'ext-1,Opening Keynote (revised)',
      'ext-2,Deep Dive',
    ].join('\n');
    const preview2 = (await (await upload(admin.cookie, 'sessions', eventId, 'sessions.csv', second)).json()) as PlanBody;
    expect(preview2.rows.map((r) => r.action)).toEqual(['update', 'update']);
    await post('/import/commit', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      headers: preview2.headers,
      rows: preview2.rows_raw,
      mapping: preview2.mapping,
    });
    const after = await env.DB.prepare('SELECT title FROM submissions WHERE event_id = ? AND client_session_id = ?')
      .bind(eventId, 'ext-1')
      .first<{ title: string }>();
    expect(after?.title).toBe('Opening Keynote (revised)');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE event_id = ?').bind(eventId).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('honours an edited mapping on the re-preview round trip', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const sheet = 'Name,Notes\nLightning Talk,Bring a laptop';
    const first = (await (await upload(admin.cookie, 'sessions', eventId, 's.csv', sheet)).json()) as PlanBody;
    expect(first.mapping[0]).toBe('title');

    // Organiser drops the Notes column and keeps only the title.
    const res = await post('/import/preview', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      headers: first.headers,
      rows: first.rows_raw,
      mapping: ['title', ''],
    });
    const plan = (await res.json()) as PlanBody;
    expect(plan.mapping).toEqual(['title', '']);
    expect(plan.rows[0]).toMatchObject({ action: 'create', label: 'Lightning Talk' });
  });

  it('refuses an import with no target event (the workspace "All events" mode)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await upload(admin.cookie, 'sessions', '', 'sessions.csv', SHEET);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'event_required' });
  });

  it('refuses reviewers and other events', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const reviewer = await seedStaff(eventA, 'reviewer');
    const adminB = await seedStaff(eventB, 'admin');
    expect((await upload(reviewer.cookie, 'sessions', eventA, 's.csv', SHEET)).status).toBe(403);
    expect((await upload(adminB.cookie, 'sessions', eventA, 's.csv', SHEET)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Contacts (the rubric fixture)
// ---------------------------------------------------------------------------

describe('speaker import', () => {
  const ROSTER = [
    'First Name,Last Name,Email,Company,Job Title',
    'Ada,Lovelace,ada@example.com,Analytical Engines,Chief Engineer',
    'Grace,Hopper,grace@example.com,US Navy,Rear Admiral',
    'Dana,Kowalski,dana@example.com,Kowalski Labs,Principal Researcher',
  ].join('\n');

  // Since 0015 the identity (name, email) and the per-event profile (company,
  // job title) are two rows, so the fixture that writes both is the only way to
  // seed a speaker who is really on this event's roster.
  const seedRoster = async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    // Ada already has a company on file (must not be clobbered) but no job title.
    await seedContact(eventId, {
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company: 'Babbage & Co',
    });
    // Grace is complete — nothing for the import to fill.
    await seedContact(eventId, {
      email: 'grace@example.com',
      first_name: 'Grace',
      last_name: 'Hopper',
      company: 'US Navy',
      job_title: 'Rear Admiral',
    });
    return { eventId, admin };
  };

  it('previews two known speakers as merged/skipped and the new person as a create', async () => {
    const { eventId, admin } = await seedRoster();
    const plan = (await (await upload(admin.cookie, 'contacts', eventId, 'speakers.csv', ROSTER)).json()) as PlanBody;

    expect(plan.mapping).toEqual(['first_name', 'last_name', 'email', 'company', 'job_title']);
    expect(plan.rows.map((r) => r.action)).toEqual(['merge', 'skip', 'create']);
    expect(plan.rows[0].message).toContain('job_title');
    expect(plan.rows[1].message).toContain('nothing blank to fill');
    expect(plan.rows[2].label).toBe('Dana Kowalski');
    expect(plan.summary).toMatchObject({ create: 1, merge: 1, skip: 1, total: 3 });
  });

  it('commits: Dana joins the roster, Ada gains only her blank field, Grace is untouched', async () => {
    const { eventId, admin } = await seedRoster();
    const preview = (await (await upload(admin.cookie, 'contacts', eventId, 'speakers.csv', ROSTER)).json()) as PlanBody;
    const res = await post('/import/commit', admin.cookie, {
      target: 'contacts',
      event_id: eventId,
      headers: preview.headers,
      rows: preview.rows_raw,
      mapping: preview.mapping,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: { create: 1, merge: 1, skip: 1 } });

    // Roster listing shape: membership drives the rows, identity joins on.
    const { results } = await env.DB.prepare(
      `SELECT c.email, c.first_name, c.last_name, ec.company, ec.job_title
       FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE ec.event_id = ? AND c.email LIKE '%@example.com' AND c.email NOT LIKE 'admin-%'
       ORDER BY c.email`,
    )
      .bind(eventId)
      .all<Record<string, string | null>>();
    expect(results.map((r) => r.email)).toEqual(['ada@example.com', 'dana@example.com', 'grace@example.com']);
    // Fill-blanks, never clobber: the sheet's "Analytical Engines" loses to the
    // stored company, but the empty job title is filled.
    expect(results[0]).toMatchObject({ company: 'Babbage & Co', job_title: 'Chief Engineer' });
    expect(results[1]).toMatchObject({ first_name: 'Dana', last_name: 'Kowalski', company: 'Kowalski Labs' });
    expect(results[2]).toMatchObject({ company: 'US Navy', job_title: 'Rear Admiral' });
  });

  it('flags invalid and in-file duplicate emails without failing the import', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const sheet = [
      'Email,First Name',
      'nope,Broken',
      'dup@example.com,First',
      'dup@example.com,Second',
      ',Nameless',
    ].join('\n');
    const plan = (await (await upload(admin.cookie, 'contacts', eventId, 'x.csv', sheet)).json()) as PlanBody;
    expect(plan.rows.map((r) => r.action)).toEqual(['error', 'create', 'skip', 'error']);
    expect(plan.rows[2].message).toContain('Duplicate email');

    await post('/import/commit', admin.cookie, {
      target: 'contacts',
      event_id: eventId,
      headers: plan.headers,
      rows: plan.rows_raw,
      mapping: plan.mapping,
    });
    const { results } = await env.DB.prepare(
      `SELECT c.email FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE ec.event_id = ? AND c.email NOT LIKE 'admin-%'`,
    ).bind(eventId).all<{ email: string }>();
    expect(results.map((r) => r.email)).toEqual(['dup@example.com']);
  });

  it('attaches a speaker who already exists elsewhere in the org, seeding the profile but not the notes', async () => {
    // One org, two events — the whole reason `attach` exists. seedEvent mints a
    // fresh org per event unless it is told otherwise, so name it explicitly.
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId });
    const eventB = await seedEvent({ org_id: orgId });
    const admin = await seedStaff(eventB, 'admin');
    await seedContact(eventA, {
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      biography: 'Wrote the first published algorithm.',
      company: 'Analytical Engines',
      job_title: 'Chief Engineer',
      notes: "Event A's private note — must not travel.",
    });

    // Identity columns only: the profile must arrive from event A, not the sheet.
    const sheet = ['First Name,Last Name,Email', 'Ada,Lovelace,ada@example.com'].join('\n');
    const plan = (await (await upload(admin.cookie, 'contacts', eventB, 'speakers.csv', sheet)).json()) as PlanBody;
    expect(plan.rows.map((r) => r.action)).toEqual(['attach']);
    expect(plan.rows[0].message).toContain('Already in this organisation');
    expect(plan.summary).toMatchObject({ attach: 1, create: 0, merge: 0, skip: 0, total: 1 });

    const res = await post('/import/commit', admin.cookie, {
      target: 'contacts',
      event_id: eventB,
      headers: plan.headers,
      rows: plan.rows_raw,
      mapping: plan.mapping,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: { attach: 1, create: 0, total: 1 } });

    // One person in the org, not two: the import matched rather than minted.
    const identities = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND email = ?',
    ).bind(orgId, 'ada@example.com').first<{ n: number }>();
    expect(identities?.n).toBe(1);

    const joined = await env.DB.prepare(
      `SELECT ec.source, ec.biography, ec.company, ec.job_title, ec.notes
       FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE ec.event_id = ? AND c.email = ?`,
    ).bind(eventB, 'ada@example.com').first<Record<string, string | null>>();
    expect(joined).toMatchObject({
      source: 'import',
      biography: 'Wrote the first published algorithm.',
      company: 'Analytical Engines',
      job_title: 'Chief Engineer',
    });
    // notes is one event team's private remark and never follows the person.
    expect(joined?.notes).toBeNull();

    // Event A keeps its own row untouched — attach adds membership, never moves it.
    const stillOnA = await env.DB.prepare(
      `SELECT ec.notes FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE ec.event_id = ? AND c.email = ?`,
    ).bind(eventA, 'ada@example.com').first<{ notes: string | null }>();
    expect(stillOnA?.notes).toBe("Event A's private note — must not travel.");
  });
});

// ---------------------------------------------------------------------------
// Files bundle
// ---------------------------------------------------------------------------

describe('files bundle ZIP', () => {
  /** One upload chain: v1 superseded, v2 current, both with distinct bytes. */
  const seedChain = async (
    eventId: string,
    submissionId: string,
    contactId: string,
    requestId: string,
    filename: string,
  ) => {
    const ts = '2026-08-01T00:00:00Z';
    for (const [version, current, body] of [[1, 0, 'OLD'], [2, 1, 'NEW']] as const) {
      const assetId = crypto.randomUUID();
      const key = `file:${assetId}`;
      await env.KV.put(key, body);
      await env.DB.prepare(
        `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, 'application/pdf', ?, ?)`,
      ).bind(assetId, eventId, key, filename, body.length, ts).run();
      await env.DB.prepare(
        `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at, version, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), requestId, contactId, submissionId, assetId, ts, version, current).run();
    }
  };

  const seedBundle = async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const requestId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO file_requests (id, event_id, title, type, created_at) VALUES (?, ?, 'Slides', 'submissions', ?)",
    ).bind(requestId, eventId, '2026-08-01T00:00:00Z').run();
    const first = await seedSubmission(eventId, { code: 'SESS-101', title: 'Opening: Keynote/2026' });
    const second = await seedSubmission(eventId, { code: 'SESS-102', title: 'Deep Dive' });
    await seedChain(eventId, first, admin.contactId, requestId, 'deck.pdf');
    await seedChain(eventId, second, admin.contactId, requestId, 'deck.pdf');
    return { eventId, admin, first, second };
  };

  it('bundles the current version of each selected submission, one folder per submission', async () => {
    const { admin, first, second } = await seedBundle();
    const res = await post('/export/files.zip', admin.cookie, { submission_ids: [first, second] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('.zip');

    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      'SESS-101-Opening-Keynote-2026/deck.pdf',
      'SESS-102-Deep-Dive/deck.pdf',
    ]);
    // Only the current version — the superseded "OLD" bytes never appear.
    for (const bytes of Object.values(entries)) expect(strFromU8(bytes)).toBe('NEW');
  });

  it('bundles only the selected submissions and 404s when the selection has no files', async () => {
    const { eventId, admin, first } = await seedBundle();
    const res = await post('/export/files.zip', admin.cookie, { submission_ids: [first] });
    expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))).toEqual([
      'SESS-101-Opening-Keynote-2026/deck.pdf',
    ]);

    const bare = await seedSubmission(eventId, { code: 'SESS-999' });
    const empty = await post('/export/files.zip', admin.cookie, { submission_ids: [bare] });
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ error: 'no_files' });
  });

  it('rejects an empty selection and another event\'s submissions', async () => {
    const { first } = await seedBundle();
    const otherEvent = await seedEvent();
    const outsider = await seedStaff(otherEvent, 'admin');
    expect((await post('/export/files.zip', outsider.cookie, { submission_ids: [] })).status).toBe(400);
    expect((await post('/export/files.zip', outsider.cookie, { submission_ids: [first] })).status).toBe(404);
  });

  /** A headshot (event_contacts) + a contact-level file-request upload with no
   * submission_id — neither has a file_request_uploads row keyed by
   * submission_id, so the pre-fix query (`u.submission_id IN (...)`) missed
   * both entirely. */
  it('includes the speaker headshot and contact-level (no-submission) uploads under the submission folder', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const requestId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO file_requests (id, event_id, title, type, created_at) VALUES (?, ?, 'Bio + ID', 'contacts', ?)",
    ).bind(requestId, eventId, '2026-08-01T00:00:00Z').run();

    const headshotAssetId = crypto.randomUUID();
    await env.KV.put(`file:${headshotAssetId}`, 'HEADSHOT-BYTES');
    await env.DB.prepare(
      `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, created_at)
       VALUES (?, ?, ?, 'headshot.jpg', 'image/jpeg', 14, ?)`,
    ).bind(headshotAssetId, eventId, `file:${headshotAssetId}`, '2026-08-01T00:00:00Z').run();
    const speaker = await seedContact(eventId, { headshot_asset_id: headshotAssetId });

    const idAssetId = crypto.randomUUID();
    await env.KV.put(`file:${idAssetId}`, 'ID-BYTES');
    await env.DB.prepare(
      `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, created_at)
       VALUES (?, ?, ?, 'id-scan.pdf', 'application/pdf', 8, ?)`,
    ).bind(idAssetId, eventId, `file:${idAssetId}`, '2026-08-01T00:00:00Z').run();
    // No submission_id: a profile-level file-request task, not tied to a talk.
    await env.DB.prepare(
      `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at, version, is_current)
       VALUES (?, ?, ?, NULL, ?, ?, 1, 1)`,
    ).bind(crypto.randomUUID(), requestId, speaker, idAssetId, '2026-08-01T00:00:00Z').run();

    const submissionId = await seedSubmission(eventId, { code: 'SESS-201', title: 'Speaker Profile Talk', submitter_contact_id: speaker });

    const res = await post('/export/files.zip', admin.cookie, { submission_ids: [submissionId] });
    expect(res.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      'SESS-201-Speaker-Profile-Talk/headshot.jpg',
      'SESS-201-Speaker-Profile-Talk/id-scan.pdf',
    ]);
    expect(strFromU8(entries['SESS-201-Speaker-Profile-Talk/headshot.jpg']!)).toBe('HEADSHOT-BYTES');
    expect(strFromU8(entries['SESS-201-Speaker-Profile-Talk/id-scan.pdf']!)).toBe('ID-BYTES');
  });
});

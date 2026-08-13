// Show-flow handoff export (workplan 15 W6/D10): GET
// /app/api/greenroom/showflow.csv|.xlsx — one generated row per scheduled
// session, running order, pencilled sessions included and marked. Also covers
// the intro-script write path from the green room screen (D10: same field,
// two save points).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseXlsx } from '../src/importer';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ORIGIN = 'https://example.com';
const getReq = (cookie: string): RequestInit => ({ method: 'GET', headers: { cookie } });

async function seedRoom(eventId: string, overrides: Partial<{ name: string; position: number; notes: string }> = {}): Promise<string> {
  const id = `room-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position, notes) VALUES (?, ?, ?, ?, ?)')
    .bind(id, eventId, overrides.name ?? 'Main Stage', overrides.position ?? 0, overrides.notes ?? null)
    .run();
  return id;
}

async function seedTrack(eventId: string, name = 'AI'): Promise<string> {
  const id = `track-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 0)')
    .bind(id, eventId, name)
    .run();
  return id;
}

async function addParticipant(
  submissionId: string,
  contactId: string,
  overrides: Partial<{ role: string; position: number; is_primary_contact: number; title_at_time: string }> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact, title_at_time)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `sp-${crypto.randomUUID().slice(0, 8)}`,
    submissionId,
    contactId,
    overrides.role ?? 'speaker',
    overrides.position ?? 0,
    overrides.is_primary_contact ?? 0,
    overrides.title_at_time ?? null,
  ).run();
}

async function scheduleSubmission(
  id: string,
  roomId: string,
  startsAt: string,
  endsAt: string,
  overrides: Partial<{ track_id: string; format: string; pencilled_at: string; intro_script: string; materials_state: string }> = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE submissions
     SET room_id = ?, starts_at = ?, ends_at = ?, status = 'accepted',
         track_id = ?, format = ?, pencilled_at = ?, intro_script = ?, materials_state = ?
     WHERE id = ?`,
  ).bind(
    roomId, startsAt, endsAt,
    overrides.track_id ?? null,
    overrides.format ?? null,
    overrides.pencilled_at ?? null,
    overrides.intro_script ?? null,
    overrides.materials_state ?? null,
    id,
  ).run();
}

async function seedCurrentDeck(eventId: string, submissionId: string, uploaderContactId: string, filename: string, uploadedAt: string): Promise<void> {
  const requestId = `fr-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO file_requests (id, event_id, title, type, created_at) VALUES (?, ?, 'Slides', 'submissions', ?)`,
  ).bind(requestId, eventId, uploadedAt).run();
  const assetId = `fa-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
     VALUES (?, ?, ?, ?, 'application/pdf', 2048, ?, ?)`,
  ).bind(assetId, eventId, `k/${assetId}`, filename, uploaderContactId, uploadedAt).run();
  await env.DB.prepare(
    `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at, is_current)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).bind(`fru-${crypto.randomUUID().slice(0, 8)}`, requestId, uploaderContactId, submissionId, assetId, uploadedAt).run();
}

describe('GET /app/api/greenroom/showflow.csv', () => {
  it('lists sessions in day/room running order, both roles on a co-presented talk, and every handoff fact', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const roomA = await seedRoom(eventId, { name: 'Hall A', position: 0, notes: 'HDMI only, no VGA adapter' });
    const roomB = await seedRoom(eventId, { name: 'Hall B', position: 1 });
    const track = await seedTrack(eventId, 'Platform');

    const lead = await seedContact(eventId, { email: 'lead@example.com', first_name: 'Priya', last_name: 'Lead' });
    await env.DB.prepare('UPDATE contacts SET mobile_phone = ? WHERE id = ?').bind('+1 555 000 1111', lead).run();
    const co = await seedContact(eventId, { email: 'co@example.com', first_name: 'Sam', last_name: 'Co' });

    // Later start, room B — must sort after the Hall A talk despite being
    // seeded first, proving the export orders by the schedule, not insertion.
    const second = await seedSubmission(eventId, { code: 'SESS-002', title: 'Second Talk' });
    await scheduleSubmission(second, roomB, '2026-10-01T15:00:00Z', '2026-10-01T16:00:00Z', {
      format: 'Talk', intro_script: 'Solo session intro.',
    });

    const first = await seedSubmission(eventId, { code: 'SESS-001', title: 'Co-Presented Talk' });
    await scheduleSubmission(first, roomA, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', {
      track_id: track, format: 'Panel', intro_script: 'Please welcome our two speakers.', materials_state: 'final',
    });
    await addParticipant(first, lead, { role: 'speaker', position: 0, is_primary_contact: 1, title_at_time: 'VP Engineering' });
    await addParticipant(first, co, { role: 'co-speaker', position: 1, title_at_time: 'Staff Engineer' });
    await seedCurrentDeck(eventId, first, lead, 'co-presented-final.pdf', '2026-09-30T12:00:00Z');
    await env.DB.prepare('UPDATE event_contacts SET arrived_at = ? WHERE event_id = ? AND contact_id = ?')
      .bind('2026-10-01T08:30:00Z', eventId, lead).run();

    const res = await SELF.fetch(`${ORIGIN}/app/api/greenroom/showflow.csv`, getReq(admin.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');

    const grid = parseCsv(await res.text());
    const header = grid[0]!;
    const rows = grid.slice(1);

    // Running order: the 09:00 Hall A session first, the 15:00 Hall B session second.
    const codeCol = header.indexOf('code');
    expect(rows[0]![codeCol]).toBe('SESS-001');
    expect(rows[1]![codeCol]).toBe('SESS-002');

    // Both the primary speaker and the co-presenter are listed, with role and
    // title_at_time, on the co-presented row.
    const speakersCol = header.indexOf('speakers');
    const speakersCell = rows[0]![speakersCol]!;
    expect(speakersCell).toContain('Priya Lead');
    expect(speakersCell).toContain('VP Engineering');
    expect(speakersCell).toContain('speaker');
    expect(speakersCell).toContain('Sam Co');
    expect(speakersCell).toContain('Staff Engineer');
    expect(speakersCell).toContain('co-speaker');
    expect(speakersCell).toContain('arrived'); // lead has checked in

    expect(rows[0]![header.indexOf('primary_contact')]).toBe('Priya Lead');
    expect(rows[0]![header.indexOf('primary_contact_mobile')]).toBe('+1 555 000 1111');
    expect(rows[0]![header.indexOf('intro_script')]).toBe('Please welcome our two speakers.');
    expect(rows[0]![header.indexOf('materials_state')]).toBe('final');
    expect(rows[0]![header.indexOf('deck_filename')]).toBe('co-presented-final.pdf');
    expect(rows[0]![header.indexOf('av_notes')]).toBe('HDMI only, no VGA adapter');
    expect(rows[0]![header.indexOf('room')]).toBe('Hall A');
    expect(rows[0]![header.indexOf('track')]).toBe('Platform');
    expect(rows[0]![header.indexOf('format')]).toBe('Panel');
  });

  it('includes a pencilled session and marks it, rather than dropping it', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const room = await seedRoom(eventId);

    const pencilled = await seedSubmission(eventId, { code: 'SESS-PEN', title: 'Half-placed talk' });
    await scheduleSubmission(pencilled, room, '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z', {
      pencilled_at: '2026-09-28T00:00:00Z',
    });
    const confirmed = await seedSubmission(eventId, { code: 'SESS-CONF', title: 'Confirmed talk' });
    await scheduleSubmission(confirmed, room, '2026-10-01T13:00:00Z', '2026-10-01T14:00:00Z');

    const res = await SELF.fetch(`${ORIGIN}/app/api/greenroom/showflow.csv`, getReq(admin.cookie));
    const grid = parseCsv(await res.text());
    const header = grid[0]!;
    const rows = grid.slice(1);

    const codeCol = header.indexOf('code');
    const pencilledCol = header.indexOf('pencilled');
    const penRow = rows.find((r) => r[codeCol] === 'SESS-PEN');
    const confRow = rows.find((r) => r[codeCol] === 'SESS-CONF');
    expect(penRow).toBeTruthy();
    expect(penRow![pencilledCol]).toBe('PENCILLED');
    expect(confRow![pencilledCol]).toBe('');
  });

  it('produces an XLSX that the importer reader parses back out', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const room = await seedRoom(eventId);
    const submission = await seedSubmission(eventId, { code: 'SESS-X', title: 'Roundtrip talk' });
    await scheduleSubmission(submission, room, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', {
      intro_script: 'Read this, exactly.',
    });

    const res = await SELF.fetch(`${ORIGIN}/app/api/greenroom/showflow.xlsx`, getReq(admin.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toContain('showflow');

    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50); // zip signature
    expect(buf[1]).toBe(0x4b);

    const grid = parseXlsx(buf);
    const header = grid[0]!;
    const codeCol = header.indexOf('code');
    const introCol = header.indexOf('intro_script');
    const dataRow = grid.find((r, i) => i > 0 && r[codeCol] === 'SESS-X');
    expect(dataRow).toBeTruthy();
    expect(dataRow![introCol]).toBe('Read this, exactly.');
  });
});

describe('POST /app/api/greenroom/intro-script', () => {
  it('saves the intro script and returns it on the refreshed green room payload', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const room = await seedRoom(eventId);
    const submission = await seedSubmission(eventId, { title: 'Talk needing an intro' });
    await scheduleSubmission(submission, room, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z');

    const res = await SELF.fetch(
      `${ORIGIN}/app/api/greenroom/intro-script`,
      jsonReq(admin.cookie, { submission_id: submission, intro_script: 'Welcome our next speaker.' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sessions: Array<{ id: string; intro_script: string | null }> };
    expect(body.ok).toBe(true);
    const row = body.sessions.find((s) => s.id === submission);
    expect(row?.intro_script).toBe('Welcome our next speaker.');

    const stored = await env.DB.prepare('SELECT intro_script FROM submissions WHERE id = ?')
      .bind(submission)
      .first<{ intro_script: string | null }>();
    expect(stored?.intro_script).toBe('Welcome our next speaker.');
  });

  it("404s a submission outside the caller's event", async () => {
    const mine = await seedEvent();
    const theirs = await seedEvent();
    const admin = await seedStaff(mine, 'admin');
    const foreign = await seedSubmission(theirs);

    const res = await SELF.fetch(
      `${ORIGIN}/app/api/greenroom/intro-script`,
      jsonReq(admin.cookie, { submission_id: foreign, intro_script: 'nope' }),
    );
    expect(res.status).toBe(404);
  });
});

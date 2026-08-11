// Workplan 11 — Sessionboard import: source profile wired through preview /
// commit, speaker↔session linking, tags, extra capture, batch undo + report.
// The generic-source path must stay byte-for-byte what it was; the last
// describe block asserts that parity directly.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff } from './fixtures-admin';
import {
  SB_CONTACTS_CSV,
  SB_HORRORS_CSV,
  SB_SESSIONS_CSV,
  buildSbSessionsXlsx,
} from './fixtures-sessionboard';
import { excelSerialToIso } from '../src/sourceProfiles';

const ORIGIN = 'https://example.com';

const post = (path: string, cookie: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}/app/api${path}`, jsonReq(cookie, body, 'POST'));

const get = (path: string, cookie: string) =>
  SELF.fetch(`${ORIGIN}/app/api${path}`, { headers: { cookie } });

const upload = (
  cookie: string,
  target: string,
  eventId: string,
  filename: string,
  content: string | Uint8Array,
  source?: string,
) => {
  const form = new FormData();
  form.set('target', target);
  form.set('event_id', eventId);
  if (source) form.set('source', source);
  form.set('file', new File([content as BlobPart], filename));
  return SELF.fetch(`${ORIGIN}/app/api/import/preview`, { method: 'POST', headers: { cookie }, body: form });
};

interface PlanRow {
  row: number;
  action: string;
  message: string | null;
  label: string;
  errors: string[];
  values: Record<string, string>;
  speakerLinks: { contactId: string; label: string }[] | null;
  extra: Record<string, string> | null;
}
interface PlanBody {
  source: string;
  mapping: string[];
  headers: string[];
  rows: PlanRow[];
  rows_raw: string[][];
  summary: Record<string, number>;
  newTracks: string[];
  newRooms: string[];
  newTags: string[];
  warnings?: string[];
  event_id: string;
}
interface CommitBody {
  ok: boolean;
  applied: Record<string, number>;
  batchId: string | null;
  plan_rows: PlanRow[];
}

/** Preview + commit one file with source=sessionboard, returning both bodies. */
async function importFile(
  cookie: string,
  target: string,
  eventId: string,
  filename: string,
  content: string | Uint8Array,
): Promise<{ plan: PlanBody; commit: CommitBody }> {
  const res = await upload(cookie, target, eventId, filename, content, 'sessionboard');
  expect(res.status).toBe(200);
  const plan = (await res.json()) as PlanBody;
  const commitRes = await post('/import/commit', cookie, {
    target,
    event_id: eventId,
    source: 'sessionboard',
    filename,
    headers: plan.headers,
    rows: plan.rows_raw,
    mapping: plan.mapping,
  });
  expect(commitRes.status).toBe(200);
  return { plan, commit: (await commitRes.json()) as CommitBody };
}

/** The fixture contract's contact pool: Ada, Grace, and two Alex Smiths. */
async function seedPool(eventId: string): Promise<void> {
  await seedContact(eventId, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
  await seedContact(eventId, { email: 'grace@example.com', first_name: 'Grace', last_name: 'Hopper' });
  await seedContact(eventId, { email: 'alex.smith1@example.com', first_name: 'Alex', last_name: 'Smith' });
  await seedContact(eventId, { email: 'alex.smith2@example.com', first_name: 'Alex', last_name: 'Smith' });
}

// ---------------------------------------------------------------------------
// (a) Contacts import
// ---------------------------------------------------------------------------

describe('sessionboard contacts import', () => {
  it('creates contacts and captures unmapped columns in extra', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const { plan, commit } = await importFile(admin.cookie, 'contacts', eventId, 'people.csv', SB_CONTACTS_CSV);
    // Sessionboard header spellings all bind; Headshot and T-Shirt Size stay unmapped.
    expect(plan.mapping).toEqual([
      'first_name', 'last_name', 'email', 'company', 'job_title', 'mobile_phone', 'biography', '', '',
    ]);
    expect(plan.rows.map((r) => r.action)).toEqual(['create', 'create', 'create', 'create', 'create', 'error']);
    expect(commit.applied).toMatchObject({ create: 5, error: 1, total: 6 });
    expect(commit.batchId).toBeTruthy();

    const ada = await env.DB.prepare(
      `SELECT c.first_name, ec.company, ec.extra, ec.import_batch_id
         FROM contacts c JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.email = 'ada@example.com'`,
    ).bind(eventId).first<Record<string, string | null>>();
    expect(ada).toMatchObject({ first_name: 'Ada', company: 'Analytical Engines', import_batch_id: commit.batchId });
    const extra = JSON.parse(ada?.extra ?? '{}') as Record<string, string>;
    expect(extra['T-Shirt Size']).toBe('M');
    expect(extra.Headshot).toContain('https://');
  });
});

// ---------------------------------------------------------------------------
// (b) Sessions import: links, statuses, timezone, tags, batch
// ---------------------------------------------------------------------------

describe('sessionboard sessions import', () => {
  it('links speakers, degrades custom statuses, converts wall-clock datetimes and creates tags', async () => {
    const eventId = await seedEvent({ timezone: 'America/New_York' });
    const admin = await seedStaff(eventId, 'admin');
    await seedPool(eventId);

    const res = await upload(admin.cookie, 'sessions', eventId, 'sessions.csv', SB_SESSIONS_CSV, 'sessionboard');
    expect(res.status).toBe(200);
    const plan = (await res.json()) as PlanBody;
    expect(plan.source).toBe('sessionboard');
    expect(plan.mapping).toContain('speakers');
    expect(plan.mapping).toContain('tags');

    // Names resolve to the seeded contacts; the two-Alex-Smith name warns, no link.
    const first = plan.rows[0];
    expect(first.speakerLinks?.map((l) => l.label)).toEqual(['Ada Lovelace', 'Grace Hopper']);
    const alexRow = plan.rows[3];
    expect(alexRow.speakerLinks).toBeNull();
    expect(alexRow.message).toContain("matches multiple contacts — not linked");
    expect(plan.warnings).toContain("speaker 'Alex Smith' matches multiple contacts — not linked");

    // Custom status degrades to pending with a note, not an error.
    expect(first.action).toBe('create');
    expect(first.values.status).toBe('pending');
    expect(first.message).toContain('Keynote Confirmed');

    // Wall-clock `2026-09-14 09:00` in America/New_York (EDT, UTC-4) → 13:00Z.
    expect(first.values.starts_at).toBe('2026-09-14T13:00:00.000Z');

    const commitRes = await post('/import/commit', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      source: 'sessionboard',
      filename: 'sessions.csv',
      headers: plan.headers,
      rows: plan.rows_raw,
      mapping: plan.mapping,
    });
    expect(commitRes.status).toBe(200);
    const commit = (await commitRes.json()) as CommitBody;
    expect(commit.batchId).toBeTruthy();
    expect(commit.applied.create).toBe(8);

    const keynote = await env.DB.prepare(
      `SELECT id, status, starts_at, import_batch_id FROM submissions WHERE event_id = ? AND client_session_id = 'SB-1001'`,
    ).bind(eventId).first<{ id: string; status: string; starts_at: string; import_batch_id: string }>();
    expect(keynote).toMatchObject({
      status: 'pending',
      starts_at: '2026-09-14T13:00:00.000Z',
      import_batch_id: commit.batchId,
    });

    // Two participant links, in cell order, stamped with the batch.
    const { results: participants } = await env.DB.prepare(
      `SELECT c.email, sp.role, sp.position, sp.import_batch_id
         FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
        WHERE sp.submission_id = ? ORDER BY sp.position`,
    ).bind(keynote?.id).all<Record<string, string | number>>();
    expect(participants.map((p) => p.email)).toEqual(['ada@example.com', 'grace@example.com']);
    expect(participants.every((p) => p.role === 'speaker' && p.import_batch_id === commit.batchId)).toBe(true);

    // Pipe tags split, created once and linked.
    const { results: tagLinks } = await env.DB.prepare(
      `SELECT tg.name FROM submission_tags st JOIN tags tg ON tg.id = st.tag_id WHERE st.submission_id = ? ORDER BY tg.name`,
    ).bind(keynote?.id).all<{ name: string }>();
    expect(tagLinks.map((t) => t.name)).toEqual(['AI', 'Infrastructure']);
    const tagCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tags WHERE event_id = ? AND name = 'AI'",
    ).bind(eventId).first<{ n: number }>();
    expect(tagCount?.n).toBe(1);

    // The ambiguous Alex Smith row imported unlinked.
    const workshop = await env.DB.prepare(
      `SELECT id FROM submissions WHERE event_id = ? AND client_session_id = 'SB-1004'`,
    ).bind(eventId).first<{ id: string }>();
    const alexLinks = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submission_participants WHERE submission_id = ?',
    ).bind(workshop?.id).first<{ n: number }>();
    expect(alexLinks?.n).toBe(0);
  });

  // (c) Re-running the same file updates, and links stay single.
  it('is idempotent on re-import: updates by Session ID, no duplicate links', async () => {
    const eventId = await seedEvent({ timezone: 'America/New_York' });
    const admin = await seedStaff(eventId, 'admin');
    await seedPool(eventId);

    await importFile(admin.cookie, 'sessions', eventId, 'sessions.csv', SB_SESSIONS_CSV);
    const second = await importFile(admin.cookie, 'sessions', eventId, 'sessions.csv', SB_SESSIONS_CSV);
    // Every row with a Session ID updates; only the blank-ID row creates again.
    expect(second.plan.rows.filter((r) => r.action === 'update')).toHaveLength(7);
    expect(second.plan.rows.filter((r) => r.action === 'create')).toHaveLength(1);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE event_id = ? AND client_session_id = 'SB-1001'",
    ).bind(eventId).first<{ n: number }>();
    expect(count?.n).toBe(1);
    const links = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
       WHERE s.event_id = ? AND s.client_session_id = 'SB-1001'`,
    ).bind(eventId).first<{ n: number }>();
    expect(links?.n).toBe(2);
  });

  // (d) Missing upsert key → loud plan-level warning.
  it('warns when no Session ID column is mapped', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const first = (await (
      await upload(admin.cookie, 'sessions', eventId, 'sessions.csv', SB_SESSIONS_CSV, 'sessionboard')
    ).json()) as PlanBody;
    expect(first.warnings ?? []).not.toContain(
      'No Session ID column mapped — every row will create a new session; re-running this import will duplicate.',
    );

    const blanked = first.mapping.map((k) => (k === 'client_session_id' ? '' : k));
    const res = await post('/import/preview', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      source: 'sessionboard',
      headers: first.headers,
      rows: first.rows_raw,
      mapping: blanked,
    });
    const plan = (await res.json()) as PlanBody;
    expect(plan.warnings?.[0]).toBe(
      'No Session ID column mapped — every row will create a new session; re-running this import will duplicate.',
    );
  });
});

// ---------------------------------------------------------------------------
// (e) Undo + report
// ---------------------------------------------------------------------------

describe('import batch undo and report', () => {
  it('deletes batch-created rows, orphan-guards created contacts, and reports undone', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    // Ada pre-exists: undo must leave her (and her membership) alone.
    const adaId = await seedContact(eventId, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });

    const contactsRun = await importFile(admin.cookie, 'contacts', eventId, 'people.csv', SB_CONTACTS_CSV);
    const sessionsRun = await importFile(admin.cookie, 'sessions', eventId, 'sessions.csv', SB_SESSIONS_CSV);
    const contactsBatch = contactsRun.commit.batchId as string;
    const sessionsBatch = sessionsRun.commit.batchId as string;
    expect(contactsBatch).toBeTruthy();
    expect(sessionsBatch).toBeTruthy();

    // Sessions first (their participants reference the imported contacts).
    const undoSessions = await post(`/import/batches/${sessionsBatch}/undo`, admin.cookie, { event_id: eventId });
    expect(undoSessions.status).toBe(200);
    const undone1 = (await undoSessions.json()) as { undone: Record<string, number> };
    // meta.changes counts cascade-deleted children too (submission_tags links
    // ride along with their submissions), so >= is the honest assertion; the
    // COUNT query below pins the exact submissions outcome.
    expect(undone1.undone.submissions).toBeGreaterThanOrEqual(8);
    expect(undone1.undone.submission_participants).toBeGreaterThan(0);

    const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE event_id = ?')
      .bind(eventId).first<{ n: number }>();
    expect(subs?.n).toBe(0);

    const undoContacts = await post(`/import/batches/${contactsBatch}/undo`, admin.cookie, { event_id: eventId });
    expect(undoContacts.status).toBe(200);
    const undone2 = (await undoContacts.json()) as { undone: Record<string, number> };
    expect(undone2.undone.event_contacts).toBe(4); // grace, 2× alex, dana — not Ada

    // Created org contacts are gone; the pre-existing one is untouched.
    const grace = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'grace@example.com' AND org_id = (SELECT org_id FROM events WHERE id = ?)")
      .bind(eventId).first<{ n: number }>();
    expect(grace?.n).toBe(0);
    const ada = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(adaId).first();
    expect(ada).not.toBeNull();
    const adaMembership = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventId, adaId).first<{ n: number }>();
    expect(adaMembership?.n).toBe(1);

    // Batch listing reports both as undone; a second undo is refused.
    const list = await get(`/import/batches?event_id=${eventId}`, admin.cookie);
    expect(list.status).toBe(200);
    const { batches } = (await list.json()) as {
      batches: { id: string; filename: string | null; summary: Record<string, number> | null; undone_at: string | null }[];
    };
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.undone_at !== null)).toBe(true);
    expect(batches.map((b) => b.filename).sort()).toEqual(['people.csv', 'sessions.csv']);
    expect((await post(`/import/batches/${sessionsBatch}/undo`, admin.cookie, { event_id: eventId })).status).toBe(409);

    // report.csv still renders off the stored plan.
    const report = await get(`/import/batches/${sessionsBatch}/report.csv?event_id=${eventId}`, admin.cookie);
    expect(report.status).toBe(200);
    expect(report.headers.get('content-type')).toContain('text/csv');
    const text = await report.text();
    expect(text).toContain('row,action,label,message');
    expect(text).toContain('Keynote: The Future of Computing');
  });
});

// ---------------------------------------------------------------------------
// (f) Horrors file
// ---------------------------------------------------------------------------

describe('sessionboard horrors file', () => {
  it('parses BOM/CRLF, errors only the truly broken rows, and never splits "Smith, Alex"', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedPool(eventId);

    const res = await upload(admin.cookie, 'sessions', eventId, 'horrors.csv', SB_HORRORS_CSV, 'sessionboard');
    expect(res.status).toBe(200);
    const plan = (await res.json()) as PlanBody;
    expect(plan.rows).toHaveLength(8);

    // Smart quotes + emoji survive the parse.
    expect(plan.rows[0].label).toContain('Edge Computing');
    // Blank title errors the row; nothing else does.
    expect(plan.rows[1].action).toBe('error');
    expect(plan.rows[1].errors).toEqual(['Title is required']);
    expect(plan.rows.filter((r) => r.action === 'error')).toHaveLength(1);
    // Unknown status degrades with a note.
    expect(plan.rows[2].action).toBe('create');
    expect(plan.rows[2].values.status).toBe('pending');
    expect(plan.rows[2].message).toContain('Mythical Status');
    // Unknown email → warning, no link, no error.
    expect(plan.rows[3].speakerLinks).toBeNull();
    expect(plan.warnings).toContain("speaker 'nobody@example.com' not found");
    // Ambiguous name → warning, no guess.
    expect(plan.rows[4].speakerLinks).toBeNull();
    expect(plan.warnings).toContain("speaker 'Alex Smith' matches multiple contacts — not linked");
    // "Smith, Alex" is ONE fragment (no comma split on names) and finds nobody.
    expect(plan.rows[5].speakerLinks).toBeNull();
    expect(plan.warnings).toContain("speaker 'Smith, Alex' not found");
    // Mixed name+email cell resolves both.
    expect(plan.rows[7].speakerLinks?.map((l) => l.label)).toEqual(['Ada Lovelace', 'grace@example.com']);

    // The whole file still commits its good rows.
    const commit = await post('/import/commit', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      source: 'sessionboard',
      headers: plan.headers,
      rows: plan.rows_raw,
      mapping: plan.mapping,
    });
    expect(commit.status).toBe(200);
    const body = (await commit.json()) as CommitBody;
    expect(body.applied).toMatchObject({ create: 7, error: 1, total: 8 });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE event_id = ?')
      .bind(eventId).first<{ n: number }>();
    expect(count?.n).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// (g) XLSX path incl. the serial-date cell
// ---------------------------------------------------------------------------

describe('sessionboard XLSX import', () => {
  it('imports the workbook and converts the Excel serial-date cell in the event timezone', async () => {
    const timezone = 'America/New_York';
    const eventId = await seedEvent({ timezone });
    const admin = await seedStaff(eventId, 'admin');
    await seedPool(eventId);

    const { plan, commit } = await importFile(
      admin.cookie, 'sessions', eventId, 'sessions.xlsx', buildSbSessionsXlsx(),
    );
    expect(plan.rows).toHaveLength(3);
    expect(commit.applied.create).toBe(3);

    const serial = await env.DB.prepare(
      "SELECT starts_at FROM submissions WHERE event_id = ? AND client_session_id = 'SB-1002'",
    ).bind(eventId).first<{ starts_at: string }>();
    expect(serial?.starts_at).toBe(excelSerialToIso(46297.396, timezone));
    const wallClock = await env.DB.prepare(
      "SELECT starts_at FROM submissions WHERE event_id = ? AND client_session_id = 'SB-1001'",
    ).bind(eventId).first<{ starts_at: string }>();
    expect(wallClock?.starts_at).toBe('2026-09-14T13:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Generic source: exactly today's behaviour
// ---------------------------------------------------------------------------

describe('generic source parity', () => {
  it('creates no batch, captures no extra and stamps nothing', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const sheet = [
      'Session ID,Title,Unmapped Column',
      'ext-1,Opening Keynote,ignored',
    ].join('\n');

    const preview = (await (await upload(admin.cookie, 'sessions', eventId, 's.csv', sheet)).json()) as PlanBody;
    expect(preview.source).toBe('generic');
    expect(preview.mapping).toEqual(['client_session_id', 'title', '']);
    expect(preview.warnings).toBeUndefined();
    expect(preview.rows[0].extra).toBeNull();
    expect(preview.rows[0].speakerLinks).toBeNull();

    const commit = await post('/import/commit', admin.cookie, {
      target: 'sessions',
      event_id: eventId,
      headers: preview.headers,
      rows: preview.rows_raw,
      mapping: preview.mapping,
    });
    expect(commit.status).toBe(200);
    const body = (await commit.json()) as CommitBody;
    expect(body.batchId).toBeNull();

    const row = await env.DB.prepare(
      "SELECT extra, import_batch_id FROM submissions WHERE event_id = ? AND client_session_id = 'ext-1'",
    ).bind(eventId).first<{ extra: string | null; import_batch_id: string | null }>();
    expect(row).toMatchObject({ extra: null, import_batch_id: null });
    const batches = await env.DB.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE event_id = ?')
      .bind(eventId).first<{ n: number }>();
    expect(batches?.n).toBe(0);
  });
});

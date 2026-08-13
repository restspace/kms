// #18 (eval defect): file collection was only ever configurable per-task, via
// "Action type = File upload" on the New task form — no event-level default.
// Two small columns on `events` (0040_event_file_defaults.sql):
//  - default_file_upload_enabled: read by TaskCreateForm.tsx to pre-fill
//    Action type (admin-side test coverage, not exercised here).
//  - default_file_allowed_types: applied to a file_upload task's standing
//    file request at creation time (adminApi.ts's POST /tasks), so the
//    default reaches the task from the moment it's created rather than only
//    after a speaker's first upload (portal.ts's ensureTaskFileRequestId,
//    which never had a way to see an event default).

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff } from './fixtures-admin';

const ORIGIN = 'https://kms.test';

let eventId: string;
let admin: { contactId: string; cookie: string; email: string };

beforeEach(async () => {
  eventId = await seedEvent();
  admin = await seedStaff(eventId, 'admin');
});

describe('GET/PUT /app/api/files/settings', () => {
  it('defaults to disabled with no allowed types for a fresh event', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/settings`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, allowed_types: [] });
  });

  it('saves and round-trips the toggle and allowed types', async () => {
    const put = await SELF.fetch(
      `${ORIGIN}/app/api/files/settings`,
      jsonReq(admin.cookie, { enabled: true, allowed_types: ['application/pdf', 'image/png'] }, 'PUT'),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, enabled: true, allowed_types: ['application/pdf', 'image/png'] });

    const get = await SELF.fetch(`${ORIGIN}/app/api/files/settings`, { headers: { cookie: admin.cookie } });
    expect(await get.json()).toEqual({ enabled: true, allowed_types: ['application/pdf', 'image/png'] });
  });

  it('reviewers cannot change the setting', async () => {
    const reviewer = await seedStaff(eventId, 'reviewer');
    const put = await SELF.fetch(
      `${ORIGIN}/app/api/files/settings`,
      jsonReq(reviewer.cookie, { enabled: true, allowed_types: ['application/pdf'] }, 'PUT'),
    );
    expect(put.status).toBe(403);
  });

  it('an empty allowed_types list clears the default back to null', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/files/settings`,
      jsonReq(admin.cookie, { enabled: true, allowed_types: ['application/pdf'] }, 'PUT'),
    );
    await SELF.fetch(`${ORIGIN}/app/api/files/settings`, jsonReq(admin.cookie, { enabled: true, allowed_types: [] }, 'PUT'));
    const row = await env.DB.prepare('SELECT default_file_allowed_types FROM events WHERE id = ?')
      .bind(eventId)
      .first<{ default_file_allowed_types: string | null }>();
    expect(row?.default_file_allowed_types).toBeNull();
  });
});

describe('POST /app/api/tasks — applies the event default allowed_types to a new file_upload task', () => {
  it('seeds the standing file request with the event default when one is configured', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/files/settings`,
      jsonReq(admin.cookie, { enabled: true, allowed_types: ['application/pdf'] }, 'PUT'),
    );

    const res = await SELF.fetch(
      `${ORIGIN}/app/api/tasks`,
      jsonReq(admin.cookie, {
        title: 'Upload your slides',
        target: 'contact',
        assignment_mode: 'automatic',
        trigger: 'none',
        action_type: 'file_upload',
      }),
    );
    expect(res.status).toBe(201);
    const { id: taskId } = (await res.json()) as { id: string };

    const request = await env.DB.prepare('SELECT allowed_types FROM file_requests WHERE id = ?')
      .bind(`file-request-task-${taskId}`)
      .first<{ allowed_types: string | null }>();
    expect(request?.allowed_types).toBe(JSON.stringify(['application/pdf']));
  });

  it('creates no file_requests row when no event default is configured (pre-existing lazy-creation behaviour)', async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/app/api/tasks`,
      jsonReq(admin.cookie, {
        title: 'Upload your slides',
        target: 'contact',
        assignment_mode: 'automatic',
        trigger: 'none',
        action_type: 'file_upload',
      }),
    );
    const { id: taskId } = (await res.json()) as { id: string };
    const request = await env.DB.prepare('SELECT id FROM file_requests WHERE id = ?')
      .bind(`file-request-task-${taskId}`)
      .first();
    expect(request).toBeNull();
  });

  it('does not seed a file request for a non-file-upload task even with a default configured', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/files/settings`,
      jsonReq(admin.cookie, { enabled: true, allowed_types: ['application/pdf'] }, 'PUT'),
    );
    const res = await SELF.fetch(
      `${ORIGIN}/app/api/tasks`,
      jsonReq(admin.cookie, {
        title: 'Sign the contract',
        target: 'contact',
        assignment_mode: 'automatic',
        trigger: 'none',
        action_type: 'acknowledge',
      }),
    );
    const { id: taskId } = (await res.json()) as { id: string };
    const request = await env.DB.prepare('SELECT id FROM file_requests WHERE id = ?')
      .bind(`file-request-task-${taskId}`)
      .first();
    expect(request).toBeNull();
  });

  it('does not override an explicit file_request_id with the event default', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/files/settings`,
      jsonReq(admin.cookie, { enabled: true, allowed_types: ['application/pdf'] }, 'PUT'),
    );
    const explicitRequestId = `fr-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO file_requests (id, event_id, title, type, allowed_types, created_at)
       VALUES (?, ?, 'Headshot', 'contacts', ?, ?)`,
    ).bind(explicitRequestId, eventId, JSON.stringify(['image/png']), '2026-08-01T00:00:00Z').run();

    const res = await SELF.fetch(
      `${ORIGIN}/app/api/tasks`,
      jsonReq(admin.cookie, {
        title: 'Upload your headshot',
        target: 'contact',
        assignment_mode: 'automatic',
        trigger: 'none',
        action_type: 'file_upload',
        file_request_id: explicitRequestId,
      }),
    );
    const { id: taskId } = (await res.json()) as { id: string };
    // No standing per-task request was created; the explicit one is untouched.
    const standing = await env.DB.prepare('SELECT id FROM file_requests WHERE id = ?')
      .bind(`file-request-task-${taskId}`)
      .first();
    expect(standing).toBeNull();
    const explicit = await env.DB.prepare('SELECT allowed_types FROM file_requests WHERE id = ?')
      .bind(explicitRequestId)
      .first<{ allowed_types: string }>();
    expect(explicit?.allowed_types).toBe(JSON.stringify(['image/png']));
  });
});

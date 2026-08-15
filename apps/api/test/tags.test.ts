// The tag vocabulary: the admin CRUD behind the Settings card, the
// per-submission attach/detach behind the detail panel's chips, and the
// name-based /api/v1 write. Before these routes the `tags` table had no writer
// outside the seed and the importer.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';

const app = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

interface Tag {
  id: string;
  event_id: string;
  name: string;
  color: string | null;
}

const createTag = async (cookie: string, name: string, color?: string) => {
  const res = await app('/tags', cookie, { name, ...(color ? { color } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as Tag;
};

const tagNamesOn = async (submissionId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `SELECT tg.name FROM submission_tags st JOIN tags tg ON tg.id = st.tag_id
     WHERE st.submission_id = ? ORDER BY tg.name`,
  )
    .bind(submissionId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
};

describe('tag CRUD (/app/api/tags)', () => {
  it('creates, lists in name order, renames and recolours', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    await createTag(admin.cookie, 'needs AV');
    const zebra = await createTag(admin.cookie, 'zebra');
    await createTag(admin.cookie, 'first-timer', '#ff8800');

    const listed = (await (await app('/tags', admin.cookie, undefined, 'GET')).json()) as { items: Tag[] };
    expect(listed.items.map((t) => t.name)).toEqual(['first-timer', 'needs AV', 'zebra']);
    expect(listed.items.find((t) => t.name === 'first-timer')?.color).toBe('#ff8800');

    const renamed = await app(`/tags/${zebra.id}`, admin.cookie, { name: '  Aardvark  ', color: '#001122' }, 'PUT');
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: zebra.id, name: 'Aardvark', color: '#001122' });
  });

  it('refuses a duplicate name, case-insensitively, on create and rename', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await createTag(admin.cookie, 'Needs AV');
    const other = await createTag(admin.cookie, 'keynote material');

    const dup = await app('/tags', admin.cookie, { name: 'needs av' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'name_exists' });

    const rename = await app(`/tags/${other.id}`, admin.cookie, { name: 'NEEDS AV' }, 'PUT');
    expect(rename.status).toBe(409);
    // Renaming a tag to the name it already has is not a collision with itself.
    const noop = await app(`/tags/${other.id}`, admin.cookie, { name: 'keynote material' }, 'PUT');
    expect(noop.status).toBe(200);
  });

  it('scopes to the event and refuses reviewers', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const reviewer = await seedStaff(eventA, 'reviewer');
    const foreign = await createTag((await seedStaff(eventB, 'admin')).cookie, 'other event');

    expect((await app(`/tags/${foreign.id}`, admin.cookie, { name: 'peek' }, 'PUT')).status).toBe(404);
    expect((await app(`/tags/${foreign.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
    expect((await app('/tags', reviewer.cookie, { name: 'nope' })).status).toBe(403);

    const listed = (await (await app('/tags', admin.cookie, undefined, 'GET')).json()) as { items: Tag[] };
    expect(listed.items).toEqual([]);
  });

  it('reports usage, then deletes with the links and restores them', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const tag = await createTag(admin.cookie, 'needs AV');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId, { email: 'tagged@example.com' });
    await env.DB.batch([
      env.DB.prepare('INSERT INTO submission_tags (submission_id, tag_id) VALUES (?, ?)').bind(submissionId, tag.id),
      env.DB.prepare('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)').bind(contactId, tag.id),
    ]);

    const usage = await (await app(`/tags/${tag.id}/usage`, admin.cookie, undefined, 'GET')).json();
    expect(usage).toEqual({ submission_count: 1, contact_count: 1 });

    const deleted = await app(`/tags/${tag.id}`, admin.cookie, undefined, 'DELETE');
    expect(deleted.status).toBe(200);
    const payload = (await deleted.json()) as { tag: Tag; submission_ids: string[]; contact_ids: string[] };
    expect(payload.tag).toMatchObject({ id: tag.id, name: 'needs AV' });
    expect(payload.submission_ids).toEqual([submissionId]);
    expect(payload.contact_ids).toEqual([contactId]);
    // The links went with the row (ON DELETE CASCADE).
    expect(await tagNamesOn(submissionId)).toEqual([]);

    const restored = await app(`/tags/${tag.id}/restore`, admin.cookie, {
      name: payload.tag.name,
      color: payload.tag.color,
      submission_ids: payload.submission_ids,
      contact_ids: payload.contact_ids,
    });
    expect(restored.status).toBe(200);
    expect(await tagNamesOn(submissionId)).toEqual(['needs AV']);
    const contactLink = await env.DB.prepare('SELECT tag_id FROM contact_tags WHERE contact_id = ?')
      .bind(contactId)
      .first<{ tag_id: string }>();
    expect(contactLink?.tag_id).toBe(tag.id);

    // A double-fired Undo is a no-op, not a constraint error.
    expect((await app(`/tags/${tag.id}/restore`, admin.cookie, { name: 'needs AV', submission_ids: [submissionId] })).status).toBe(200);
    expect(await tagNamesOn(submissionId)).toEqual(['needs AV']);
  });

  it('restore will not re-link another event\'s records', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const tagId = crypto.randomUUID();
    const foreignSubmission = await seedSubmission(eventB);

    const res = await app(`/tags/${tagId}/restore`, admin.cookie, {
      name: 'reinstated',
      submission_ids: [foreignSubmission],
    });
    expect(res.status).toBe(200);
    expect(await tagNamesOn(foreignSubmission)).toEqual([]);
  });
});

describe('PUT /app/api/submissions/:id/tags', () => {
  it('replaces the whole set and returns it in name order', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const av = await createTag(admin.cookie, 'needs AV');
    const keynote = await createTag(admin.cookie, 'Keynote material');
    const submissionId = await seedSubmission(eventId);

    const added = await app(`/submissions/${submissionId}/tags`, admin.cookie, { tag_ids: [av.id, keynote.id] }, 'PUT');
    expect(added.status).toBe(200);
    expect(((await added.json()) as { tags: Tag[] }).tags.map((t) => t.name)).toEqual(['Keynote material', 'needs AV']);

    const narrowed = await app(`/submissions/${submissionId}/tags`, admin.cookie, { tag_ids: [av.id] }, 'PUT');
    expect(((await narrowed.json()) as { tags: Tag[] }).tags.map((t) => t.name)).toEqual(['needs AV']);

    const cleared = await app(`/submissions/${submissionId}/tags`, admin.cookie, { tag_ids: [] }, 'PUT');
    expect(((await cleared.json()) as { tags: Tag[] }).tags).toEqual([]);
    expect(await tagNamesOn(submissionId)).toEqual([]);
  });

  it('refuses a tag from another event rather than dropping it silently', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const foreign = await createTag((await seedStaff(eventB, 'admin')).cookie, 'other event');
    const submissionId = await seedSubmission(eventA);

    const res = await app(`/submissions/${submissionId}/tags`, admin.cookie, { tag_ids: [foreign.id] }, 'PUT');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_tag_id' });
    expect(await tagNamesOn(submissionId)).toEqual([]);
  });

  it('404s across events and refuses reviewers', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const reviewer = await seedStaff(eventA, 'reviewer');
    const foreignSubmission = await seedSubmission(eventB);
    const ownSubmission = await seedSubmission(eventA);

    expect((await app(`/submissions/${foreignSubmission}/tags`, admin.cookie, { tag_ids: [] }, 'PUT')).status).toBe(404);
    expect((await app(`/submissions/${ownSubmission}/tags`, reviewer.cookie, { tag_ids: [] }, 'PUT')).status).toBe(403);
  });
});

describe('tag_names on the submissions query', () => {
  it('joins the tags into one name-ordered list, and is null when untagged', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const av = await createTag(admin.cookie, 'needs AV');
    const keynote = await createTag(admin.cookie, 'Keynote material');
    const tagged = await seedSubmission(eventId, { title: 'Tagged' });
    const untagged = await seedSubmission(eventId, { title: 'Untagged' });
    await app(`/submissions/${tagged}/tags`, admin.cookie, { tag_ids: [av.id, keynote.id] }, 'PUT');

    const res = await app('/submissions/query', admin.cookie, { size: 50, filters: {} });
    const rows = ((await res.json()) as { items: Array<{ id: string; tag_names: string | null }> }).items;
    // Sorted by name, case-insensitively — not by the order they went on.
    expect(rows.find((r) => r.id === tagged)?.tag_names).toBe('Keynote material, needs AV');
    expect(rows.find((r) => r.id === untagged)?.tag_names).toBeNull();
  });
});

describe('/api/v1 tags', () => {
  it('replaces a submission\'s tags by name and lists the vocabulary', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const token = await seedApiToken(await orgIdForEvent(eventId));
    await createTag(admin.cookie, 'needs AV');
    await createTag(admin.cookie, 'Keynote material');
    const submissionId = await seedSubmission(eventId);

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/submissions/${submissionId}/tags`,
      // Case-insensitive on the way in; the stored spelling comes back.
      bearerReq(token, { tags: ['NEEDS av', 'Keynote material'] }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tags: ['Keynote material', 'needs AV'] });

    const listed = await SELF.fetch(`https://example.com/api/v1/events/${eventId}/tags`, bearerReq(token));
    expect(((await listed.json()) as { items: Tag[] }).items.map((t) => t.name)).toEqual([
      'Keynote material',
      'needs AV',
    ]);
  });

  it('refuses an unknown name unless create_missing is sent', async () => {
    const eventId = await seedEvent();
    const token = await seedApiToken(await orgIdForEvent(eventId));
    const submissionId = await seedSubmission(eventId);
    const url = `https://example.com/api/v1/events/${eventId}/submissions/${submissionId}/tags`;

    const refused = await SELF.fetch(url, bearerReq(token, { tags: ['nedes AV'] }, 'PUT'));
    expect(refused.status).toBe(422);
    // The /api/v1 error envelope is { error: { code, message } }.
    expect((await refused.json() as { error: { code: string } }).error.code).toBe('unknown_tag');
    expect(await tagNamesOn(submissionId)).toEqual([]);

    const created = await SELF.fetch(url, bearerReq(token, { tags: ['needs AV'], create_missing: true }, 'PUT'));
    expect(created.status).toBe(200);
    expect(await tagNamesOn(submissionId)).toEqual(['needs AV']);
    // Created on the event's vocabulary, not just on the submission.
    const row = await env.DB.prepare('SELECT name FROM tags WHERE event_id = ?').bind(eventId).first<{ name: string }>();
    expect(row?.name).toBe('needs AV');
  });

  it('404s a submission in another event', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const token = await seedApiToken(await orgIdForEvent(eventA));
    const foreign = await seedSubmission(eventB);
    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventA}/submissions/${foreign}/tags`,
      bearerReq(token, { tags: [] }, 'PUT'),
    );
    expect(res.status).toBe(404);
  });
});

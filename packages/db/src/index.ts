// D1 implementation of the repository surface in ./types (docs/02, docs/03 §5).
// All statements are prepared and bound; nothing here interpolates user input.

import type { Contact, ContactAtEvent, Event, Role, SubmissionSummary } from '@kms/core';
import type { AttachSource, Db, OutboxJob, OutboxRow } from './types';

export * from './types';

interface OutboxDbRow {
  id: string;
  kind: OutboxJob['kind'];
  idempotency_key: string;
  payload: string;
  status: OutboxRow['status'];
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

const MAX_ATTEMPTS = 8;
const CLAIM_LEASE_MS = 5 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function toOutboxRow(r: OutboxDbRow, status: OutboxRow['status'] = r.status): OutboxRow {
  return {
    id: r.id,
    kind: r.kind,
    idempotencyKey: r.idempotency_key,
    payload: JSON.parse(r.payload) as unknown,
    status,
    attempts: r.attempts,
    next_attempt_at: r.next_attempt_at,
    last_error: r.last_error,
  };
}

export function createDb(d1: D1Database): Db {
  return {
    events: {
      async getBySlug(slug: string): Promise<Event | null> {
        return await d1.prepare('SELECT * FROM events WHERE slug = ?').bind(slug).first<Event>();
      },
      async getById(id: string): Promise<Event | null> {
        return await d1.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Event>();
      },
      async listAll(): Promise<Event[]> {
        const { results } = await d1
          .prepare('SELECT * FROM events ORDER BY starts_at')
          .all<Event>();
        return results;
      },
    },

    contacts: {
      async getByEmail(orgId: string, email: string): Promise<Contact | null> {
        return await d1
          .prepare('SELECT * FROM contacts WHERE org_id = ? AND lower(email) = ?')
          .bind(orgId, email.trim().toLowerCase())
          .first<Contact>();
      },
      // The join to event_contacts IS the tenancy guard as well as the fetch:
      // a contact with no row for this event returns null rather than leaking
      // an org sibling's record (workplan §1).
      async getById(eventId: string, id: string): Promise<ContactAtEvent | null> {
        return await d1
          .prepare(
            `SELECT c.id, c.org_id, c.email, c.first_name, c.last_name, c.salutation,
                    c.honorific, c.pronouns, c.gender, c.mobile_phone, c.links,
                    c.created_at, c.updated_at,
                    ec.event_id, ec.biography, ec.headshot_asset_id, ec.company,
                    ec.job_title, ec.notes, ec.added_at, ec.source
               FROM contacts c
               JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
              WHERE c.id = ?`,
          )
          .bind(eventId, id)
          .first<ContactAtEvent>();
      },
      async getByIdOrgWide(orgId: string, id: string): Promise<Contact | null> {
        return await d1
          .prepare('SELECT * FROM contacts WHERE org_id = ? AND id = ?')
          .bind(orgId, id)
          .first<Contact>();
      },
      async upsertByEmail(orgId: string, email: string): Promise<Contact> {
        const normalised = email.trim().toLowerCase();
        const ts = nowIso();
        // Idempotent create: the unique index on (org_id, lower(email)) makes the
        // insert a no-op when the contact already exists (docs/04 §5). Dedupe
        // scope is the org, not the event, as of 0015.
        await d1
          .prepare(
            `INSERT INTO contacts (id, org_id, email, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (org_id, lower(email)) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), orgId, normalised, ts, ts)
          .run();
        const row = await d1
          .prepare('SELECT * FROM contacts WHERE org_id = ? AND lower(email) = ?')
          .bind(orgId, normalised)
          .first<Contact>();
        if (!row) throw new Error(`contacts.upsertByEmail: row missing after upsert (${normalised})`);
        return row;
      },
      // Seed-on-create, not fallback-at-read (workplan §1 "Decided semantics"):
      // the profile is copied from the contact's most recent event_contacts row
      // in the SAME org, so a returning speaker does not retype everything, while
      // a NULL still means "not set for this event" rather than "inherit".
      //
      // The inner SELECT is constrained to events sharing this event's org so a
      // profile can never be seeded across an organisation boundary.
      async attachToEvent(
        eventId: string,
        contactId: string,
        source: AttachSource,
      ): Promise<void> {
        await d1
          .prepare(
            `INSERT INTO event_contacts
               (event_id, contact_id, biography, headshot_asset_id, company,
                job_title, notes, added_at, source)
             SELECT ?1, ?2, prev.biography, NULL, prev.company, prev.job_title,
                    NULL, ?3, ?4
               FROM (SELECT ec.biography, ec.company, ec.job_title
                       FROM event_contacts ec
                       JOIN events e ON e.id = ec.event_id
                      WHERE ec.contact_id = ?2
                        AND e.org_id = (SELECT org_id FROM events WHERE id = ?1)
                      ORDER BY ec.added_at DESC
                      LIMIT 1) prev
             -- WHERE true is load-bearing: with no WHERE clause SQLite parses
             -- the following ON CONFLICT as a join constraint on prev and
             -- rejects the statement outright.
             WHERE true
             ON CONFLICT (event_id, contact_id) DO NOTHING`,
          )
          .bind(eventId, contactId, nowIso(), source)
          .run();
        // No prior profile to seed from: the SELECT above yielded no row, so
        // insert the bare membership.
        await d1
          .prepare(
            `INSERT INTO event_contacts (event_id, contact_id, added_at, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (event_id, contact_id) DO NOTHING`,
          )
          .bind(eventId, contactId, nowIso(), source)
          .run();
      },
      async listEventIds(contactId: string): Promise<string[]> {
        const { results } = await d1
          .prepare(
            'SELECT event_id FROM event_contacts WHERE contact_id = ? ORDER BY added_at DESC',
          )
          .bind(contactId)
          .all<{ event_id: string }>();
        return results.map((r) => r.event_id);
      },
    },

    eventUsers: {
      async getRole(eventId: string, contactId: string): Promise<Role> {
        const row = await d1
          .prepare('SELECT role FROM event_users WHERE event_id = ? AND contact_id = ?')
          .bind(eventId, contactId)
          .first<{ role: Role }>();
        return row?.role ?? 'speaker';
      },
    },

    submissions: {
      async listByContact(eventId: string, contactId: string): Promise<SubmissionSummary[]> {
        const { results } = await d1
          .prepare(
            `SELECT id, event_id, code, title, status, format, track_id, submitter_contact_id
             FROM submissions
             WHERE event_id = ? AND submitter_contact_id = ?
             ORDER BY created_at DESC`,
          )
          .bind(eventId, contactId)
          .all<SubmissionSummary>();
        return results;
      },
      async countByEvent(eventId: string): Promise<number> {
        const row = await d1
          .prepare('SELECT COUNT(*) AS n FROM submissions WHERE event_id = ?')
          .bind(eventId)
          .first<{ n: number }>();
        return row?.n ?? 0;
      },
    },

    outbox: {
      async enqueue(job: OutboxJob): Promise<void> {
        const ts = nowIso();
        // INSERT OR IGNORE on idempotency_key — enqueue is a no-op on replay (NFR-11).
        await d1
          .prepare(
            `INSERT OR IGNORE INTO outbox
               (id, kind, idempotency_key, payload, status, attempts, next_attempt_at, created_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .bind(crypto.randomUUID(), job.kind, job.idempotencyKey, JSON.stringify(job.payload), ts, ts)
          .run();
      },

      async claimDue(limit: number): Promise<OutboxRow[]> {
        const ts = nowIso();
        const { results: candidates } = await d1
          .prepare(
            `SELECT * FROM outbox
             WHERE status IN ('pending', 'in_flight') AND next_attempt_at <= ?
             ORDER BY next_attempt_at
             LIMIT ?`,
          )
          .bind(ts, limit)
          .all<OutboxDbRow>();
        const claimed: OutboxRow[] = [];
        const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
        for (const candidate of candidates) {
          // Conditional UPDATE is the claim: another worker that selected the
          // same candidate loses once its due timestamp has moved forward.
          const row = await d1
            .prepare(
              `UPDATE outbox SET status = 'in_flight', next_attempt_at = ?
               WHERE id = ? AND status IN ('pending', 'in_flight') AND next_attempt_at <= ?
               RETURNING *`,
            )
            .bind(leaseUntil, candidate.id, ts)
            .first<OutboxDbRow>();
          if (row) claimed.push(toOutboxRow(row, 'in_flight'));
        }
        return claimed;
      },

      async markDone(id: string): Promise<void> {
        await d1.prepare(`UPDATE outbox SET status = 'done', last_error = NULL WHERE id = ?`).bind(id).run();
      },

      async markDoneByKey(idempotencyKey: string): Promise<void> {
        await d1
          .prepare(`UPDATE outbox SET status = 'done', last_error = NULL WHERE idempotency_key = ?`)
          .bind(idempotencyKey)
          .run();
      },

      async markFailed(id: string, error: string): Promise<void> {
        const row = await d1
          .prepare('SELECT attempts FROM outbox WHERE id = ?')
          .bind(id)
          .first<{ attempts: number }>();
        if (!row) return;
        const attempts = row.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        // Exponential backoff: 2^attempts minutes (2, 4, 8, ... 256).
        const next = new Date(Date.now() + 2 ** attempts * 60_000).toISOString();
        await d1
          .prepare(
            `UPDATE outbox
             SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ?
             WHERE id = ?`,
          )
          .bind(attempts, error, dead ? 'dead' : 'pending', next, id)
          .run();
      },
    },
  };
}

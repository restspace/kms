// D1 implementation of the repository surface in ./types (docs/02, docs/03 §5).
// All statements are prepared and bound; nothing here interpolates user input.

import type { Contact, Event, Role, SubmissionSummary } from '@kms/core';
import type { Db, OutboxJob, OutboxRow } from './types';

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
      async getByEmail(eventId: string, email: string): Promise<Contact | null> {
        return await d1
          .prepare('SELECT * FROM contacts WHERE event_id = ? AND email = ?')
          .bind(eventId, email.trim().toLowerCase())
          .first<Contact>();
      },
      async getById(eventId: string, id: string): Promise<Contact | null> {
        return await d1
          .prepare('SELECT * FROM contacts WHERE event_id = ? AND id = ?')
          .bind(eventId, id)
          .first<Contact>();
      },
      async upsertByEmail(eventId: string, email: string): Promise<Contact> {
        const normalised = email.trim().toLowerCase();
        const ts = nowIso();
        // Idempotent create: the UNIQUE(event_id, email) constraint makes the
        // insert a no-op when the contact already exists (docs/04 §5).
        await d1
          .prepare(
            `INSERT INTO contacts (id, event_id, email, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (event_id, email) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), eventId, normalised, ts, ts)
          .run();
        const row = await d1
          .prepare('SELECT * FROM contacts WHERE event_id = ? AND email = ?')
          .bind(eventId, normalised)
          .first<Contact>();
        if (!row) throw new Error(`contacts.upsertByEmail: row missing after upsert (${normalised})`);
        return row;
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
        const { results } = await d1
          .prepare(
            `SELECT * FROM outbox
             WHERE status = 'pending' AND next_attempt_at <= ?
             ORDER BY next_attempt_at
             LIMIT ?`,
          )
          .bind(ts, limit)
          .all<OutboxDbRow>();
        if (results.length === 0) return [];
        const placeholders = results.map(() => '?').join(', ');
        await d1
          .prepare(`UPDATE outbox SET status = 'in_flight' WHERE id IN (${placeholders})`)
          .bind(...results.map((r) => r.id))
          .run();
        return results.map((r) => toOutboxRow(r, 'in_flight'));
      },

      async markDone(id: string): Promise<void> {
        await d1.prepare(`UPDATE outbox SET status = 'done', last_error = NULL WHERE id = ?`).bind(id).run();
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

// Repository surface consumed by the routes. Implemented over D1 in ./index.ts.
// Contract: reads are scoped; nothing here leaks rows across events (NFR-4).

import type { Contact, Event, Role, SubmissionSummary } from '@kms/core';

// Re-exported so package-internal modules and consumers can import entity types
// from '@kms/db' without a separate @kms/core import.
export type { Contact, Event, Role, SubmissionStatus, SubmissionSummary } from '@kms/core';

export interface Db {
  events: {
    getBySlug(slug: string): Promise<Event | null>;
    getById(id: string): Promise<Event | null>;
    listAll(): Promise<Event[]>; // admin shell event switcher; org-scoping arrives with multi-org
  };
  contacts: {
    getByEmail(eventId: string, email: string): Promise<Contact | null>;
    getById(eventId: string, id: string): Promise<Contact | null>;
    /** create if missing; email is normalised to lowercase (docs/04 §5 edge cases) */
    upsertByEmail(eventId: string, email: string): Promise<Contact>;
  };
  eventUsers: {
    /** role of this contact on this event; 'speaker' when no event_users row exists */
    getRole(eventId: string, contactId: string): Promise<Role>;
  };
  submissions: {
    listByContact(eventId: string, contactId: string): Promise<SubmissionSummary[]>;
    countByEvent(eventId: string): Promise<number>;
  };
  outbox: {
    enqueue(job: OutboxJob): Promise<void>;
    /** claim up to `limit` due jobs for the cron sweep */
    claimDue(limit: number): Promise<OutboxRow[]>;
    markDone(id: string): Promise<void>;
    /** settle a job after an immediate (non-sweep) send so the sweep won't resend it */
    markDoneByKey(idempotencyKey: string): Promise<void>;
    markFailed(id: string, error: string): Promise<void>;
  };
}

export interface OutboxJob {
  kind: 'email' | 'airtable_sync';
  /** unique idempotency key (NFR-11) — enqueue is a no-op if it already exists */
  idempotencyKey: string;
  payload: unknown;
}

export interface OutboxRow extends OutboxJob {
  id: string;
  attempts: number;
  status: 'pending' | 'in_flight' | 'done' | 'dead';
  next_attempt_at: string;
  last_error: string | null;
}

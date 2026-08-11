// Repository surface consumed by the routes. Implemented over D1 in ./index.ts.
// Contract: reads are scoped; nothing here leaks rows across events (NFR-4).

import type { Contact, ContactAtEvent, Event, Role, SubmissionSummary } from '@kms/core';

// Re-exported so package-internal modules and consumers can import entity types
// from '@kms/db' without a separate @kms/core import.
export type {
  Contact,
  ContactAtEvent,
  EventContact,
  Event,
  Role,
  SubmissionStatus,
  SubmissionSummary,
} from '@kms/core';

/** How a contact came to be attached to an event (event_contacts.source). */
export type AttachSource = 'import' | 'cfp' | 'admin' | 'migration';

export interface Db {
  events: {
    getBySlug(slug: string): Promise<Event | null>;
    getById(id: string): Promise<Event | null>;
    listAll(): Promise<Event[]>; // admin shell event switcher; org-scoping arrives with multi-org
  };
  contacts: {
    /** identity lookup, org-wide — a contact is not pinned to one event (0015) */
    getByEmail(orgId: string, email: string): Promise<Contact | null>;
    /**
     * Identity WITH the profile for one event. Returns null when the contact has
     * no event_contacts row for `eventId` — the join is the tenancy guard, so a
     * caller cannot read a contact belonging only to another event.
     */
    getById(eventId: string, id: string): Promise<ContactAtEvent | null>;
    /** identity only, no event scoping. Callers must guard tenancy themselves. */
    getByIdOrgWide(orgId: string, id: string): Promise<Contact | null>;
    /** create if missing; email is normalised to lowercase (docs/04 §5 edge cases) */
    upsertByEmail(orgId: string, email: string): Promise<Contact>;
    /**
     * Idempotently give `contactId` a row for `eventId`, seeding the profile from
     * their most recent event_contacts row in the same org. No-op when the row
     * already exists — it never overwrites a profile the event already has.
     */
    attachToEvent(
      eventId: string,
      contactId: string,
      source: AttachSource,
    ): Promise<void>;
    /** events in the org this contact has a row for, most recently added first */
    listEventIds(contactId: string): Promise<string[]>;
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
  kind: 'email';
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

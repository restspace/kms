// Shared domain types. Tenant isolation: every repository call takes a Scope and the
// SQL layer appends the scope predicate (docs/03 §5, docs/02 §1).

export type Role = 'owner' | 'admin' | 'reviewer' | 'speaker';

export interface Actor {
  contactId: string;
  email: string;
  role: Role;
  /** set when an admin is impersonating a speaker via "View Portal" */
  impersonatedBy?: string;
}

export interface Scope {
  orgId: string;
  eventId: string;
  actor: Actor;
}

export type SubmissionStatus =
  | 'draft'
  | 'pending'
  | 'accept_queue'
  | 'accepted'
  | 'decline_queue'
  | 'declined'
  | 'withdrawn';

export interface Event {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  type: 'conference' | 'workshop' | 'summit' | 'meetup' | 'other';
  website_url: string | null;
  location: string | null;
  timezone: string;
  starts_at: string; // ISO-8601 UTC throughout (NFR-12)
  ends_at: string;
  theme: string | null;
  default_submission_limit: number;
  agenda_published: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  event_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  biography: string | null;
  links: string | null; // json {linkedin, twitter, facebook, website}
  created_at: string;
  updated_at: string;
}

export interface SubmissionSummary {
  id: string;
  event_id: string;
  code: string;
  title: string;
  status: SubmissionStatus;
  format: string | null;
  track_id: string | null;
  submitter_contact_id: string;
}

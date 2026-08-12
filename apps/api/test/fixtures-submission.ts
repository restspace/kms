// Lane-local seed helpers for the submission-pipeline tests (sweep item P0-1).
// Deliberately narrow: a form with just enough of the default question set to
// exercise the submit batch, plus the signed cookie an authenticated
// SELF.fetch needs. Shared event/contact seeding comes from ./fixtures.

import { env } from 'cloudflare:test';
import { createContact, createEvent, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

export interface SeededForm {
  eventId: string;
  eventSlug: string;
  formId: string;
  submitterId: string;
  cookie: string;
  /** question ids by field key, across both sections */
  questions: Record<string, string>;
  basePath: string;
}

interface FieldSpec {
  key: string;
  type: string;
  scope: 'contact' | 'submission';
  section: 'abstract' | 'participant';
  required?: boolean;
}

const DEFAULT_FIELDS: FieldSpec[] = [
  { key: 'title', type: 'text', scope: 'submission', section: 'abstract', required: true },
  { key: 'description', type: 'textarea', scope: 'submission', section: 'abstract' },
  { key: 'track', type: 'multiselect', scope: 'submission', section: 'abstract' },
  { key: 'format', type: 'dropdown', scope: 'submission', section: 'abstract' },
  { key: 'first_name', type: 'text', scope: 'contact', section: 'participant', required: true },
  { key: 'last_name', type: 'text', scope: 'contact', section: 'participant', required: true },
  { key: 'email', type: 'email', scope: 'contact', section: 'participant', required: true },
  { key: 'biography', type: 'textarea', scope: 'contact', section: 'participant' },
];

export async function seedForm(
  overrides: Partial<{
    slug: string;
    submissionLimit: number | null;
    collectParticipants: boolean;
    confirmationEmail: boolean;
    notifyAdminsOnCreate: string[] | null;
    trackOptions: string[];
  }> = {},
): Promise<SeededForm> {
  const slug = overrides.slug ?? `evt-${crypto.randomUUID().slice(0, 8)}`;
  const eventId = await createEvent({ slug, default_submission_limit: 99 });
  const submitterId = await createContact(eventId, { email: 'submitter@example.com' });
  const formId = `form-${crypto.randomUUID()}`;

  await env.DB.prepare(
    `INSERT INTO submission_forms (id, event_id, internal_name, external_title, page_heading,
       collection_type, collect_participants, status, submission_limit, participant_roles,
       notify_admins_on_create, confirmation_email_enabled, created_at, updated_at)
     VALUES (?, ?, 'CFP', 'CFP', 'Submit', 'abstracts', ?, 'open', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      formId,
      eventId,
      overrides.collectParticipants === false ? 0 : 1,
      overrides.submissionLimit === undefined ? null : overrides.submissionLimit,
      JSON.stringify([{ role: 'speaker', min: 1, max: null }]),
      overrides.notifyAdminsOnCreate ? JSON.stringify(overrides.notifyAdminsOnCreate) : null,
      overrides.confirmationEmail === false ? 0 : 1,
      ts,
      ts,
    )
    .run();

  const questions: Record<string, string> = {};
  let position = 0;
  for (const spec of DEFAULT_FIELDS) {
    const fieldId = `fld-${crypto.randomUUID()}`;
    const options =
      spec.key === 'track' && overrides.trackOptions
        ? JSON.stringify(overrides.trackOptions.map((name) => ({ value: name, label: name })))
        : null;
    await env.DB.prepare(
      `INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, system)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
      .bind(fieldId, eventId, spec.key, spec.key, spec.type, spec.scope, options)
      .run();
    const qid = `q-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO form_questions (id, form_id, section, field_id, position, required, locked)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(qid, formId, spec.section, fieldId, (position += 1), spec.required ? 1 : 0)
      .run();
    questions[spec.key] = qid;
  }

  return {
    eventId,
    eventSlug: slug,
    formId,
    submitterId,
    cookie: await sessionCookieFor({ contactId: submitterId, eventId, eventSlug: slug }),
    questions,
    basePath: `/submit/${slug}/${formId}`,
  };
}

/** A minimal valid submit body for a seeded form (legacy participant shape). */
export function submitBody(form: SeededForm, title = 'A talk'): Record<string, unknown> {
  return {
    answers: { [form.questions.title!]: title },
    participants: [
      { email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' },
    ],
  };
}

/** The same body in the frozen `{role, is_primary_contact, answers}` shape. */
export function submitBodyV2(form: SeededForm, title = 'A talk'): Record<string, unknown> {
  return {
    answers: { [form.questions.title!]: title },
    participants: [
      {
        role: 'speaker',
        is_primary_contact: true,
        answers: {
          [form.questions.first_name!]: 'Sub',
          [form.questions.last_name!]: 'Mitter',
          [form.questions.email!]: 'submitter@example.com',
        },
      },
    ],
  };
}

export async function createTrack(eventId: string, name: string): Promise<string> {
  const id = `trk-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 0)')
    .bind(id, eventId, name)
    .run();
  return id;
}

export async function createFormat(eventId: string, name: string, position = 0): Promise<string> {
  const id = `fmt-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO formats (id, event_id, name, position) VALUES (?, ?, ?, ?)')
    .bind(id, eventId, name, position)
    .run();
  return id;
}

export async function createRoom(eventId: string, name: string): Promise<string> {
  const id = `room-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position) VALUES (?, ?, ?, 0)')
    .bind(id, eventId, name)
    .run();
  return id;
}

export const countRows = async (sql: string, ...binds: unknown[]): Promise<number> =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

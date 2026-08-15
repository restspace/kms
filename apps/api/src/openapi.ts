// OpenAPI 3.1 for /api/v1 (docs/10 §5). Generated at request time from the
// RESOURCES registry in adminApi.ts — filter names, their one-line semantics
// and the sortable fields come from the exact objects the query executor runs,
// so the document cannot describe an endpoint that does not exist.
//
// The audience is as much an agent as a human: every operation carries a stable
// operationId, every response points at a named schema, the row shapes name
// their columns (and their quirks — JSON-as-string, 0/1 booleans), and the
// preamble says plainly what this surface will NOT do, so a caller does not
// spend turns discovering absences.

import {
  COMMENT_KINDS,
  MATERIALS_STATES,
  MESSAGE_STATUSES,
  RESOURCES,
  SUBMISSION_STATUSES,
  TASK_ASSIGNMENT_STATUSES,
} from './routes/adminApi';
import { APPROVAL_STATES, DECISION_OUTCOMES } from './routes/evaluation';

const list = (v: Iterable<string>) => [...v];

// ---------------------------------------------------------------------------
// Reusable pieces
// ---------------------------------------------------------------------------

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const paramRef = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const responseRef = (name: string) => ({ $ref: `#/components/responses/${name}` });

const idParam = (noun: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description: `The ${noun} id (an opaque string; read it from a list response).`,
  schema: { type: 'string' },
});

const json = (schema: unknown, description: string, extra: Record<string, unknown> = {}) => ({
  description,
  content: { 'application/json': { schema } },
  ...extra,
});

/** POST responses carry this when the response was replayed from a stored
 * Idempotency-Key rather than executed again. */
const replayHeader = {
  headers: {
    'Idempotency-Replayed': {
      description: 'Present and `true` only when this response was replayed from a previous request with the same Idempotency-Key.',
      schema: { type: 'string', enum: ['true'] },
    },
  },
};

const ISO = { type: 'string', description: 'UTC ISO 8601 timestamp.' } as const;
const NULLABLE_ISO = { type: ['string', 'null'], description: 'UTC ISO 8601 timestamp, or null.' } as const;
const TEXT = { type: ['string', 'null'] } as const;
const JSON_TEXT = (what: string) =>
  ({ type: ['string', 'null'], description: `JSON encoded as a string (${what}) — parse it client-side. This surface does not expand JSON columns.` }) as const;
const BOOL_INT = (what: string) =>
  ({ type: 'integer', enum: [0, 1], description: `SQLite boolean: 1 = ${what}, 0 = not.` }) as const;

// ---------------------------------------------------------------------------
// Row schemas. `additionalProperties: true` everywhere is honest rather than
// lazy: several list rows are `SELECT table.*`, so a column added by a
// migration appears here before this file mentions it. The named properties
// are the ones a caller can rely on.
// ---------------------------------------------------------------------------

const schemas: Record<string, unknown> = {
  Error: {
    type: 'object',
    description: 'Every non-2xx response body on this surface.',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            description: 'Stable machine code — branch on this, never on `message`.',
            enum: [
              'unauthenticated',
              'invalid_token',
              'forbidden',
              'event_not_found',
              'not_found',
              'unknown_resource',
              'invalid_cursor',
              'validation',
              'invalid_status',
              'email_exists',
              'constraint',
              'idempotency_mismatch',
              'create_failed',
            ],
          },
          message: { type: 'string', description: 'Human-readable, may change; not for branching.' },
          details: {
            type: 'array',
            description: 'Per-field detail, present on `validation` (400) only.',
            items: {
              type: 'object',
              properties: { field: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
    },
  },

  Event: {
    type: 'object',
    additionalProperties: true,
    description: 'A conference/event. The unit of scope: every other path names one.',
    properties: {
      id: { type: 'string' },
      org_id: { type: 'string', description: 'Owning organisation. A bearer token can reach every event with its own org_id.' },
      name: { type: 'string' },
      slug: { type: 'string' },
      type: { type: 'string' },
      location: TEXT,
      timezone: { type: 'string', description: 'IANA zone. Schedule columns elsewhere are wall-clock in THIS zone, not the caller\'s.' },
      starts_at: ISO,
      ends_at: ISO,
      created_at: ISO,
      updated_at: ISO,
    },
  },

  Contact: {
    type: 'object',
    additionalProperties: true,
    description:
      'A person on this event\'s roster. Identity (email, name, pronouns, phone) is ORGANISATION-level and shared by every event the person appears on; profile (company, job_title, biography, notes, headshot) is per-event and lives on the roster row.',
    properties: {
      id: { type: 'string' },
      event_id: { type: 'string', description: 'The event whose roster row this is.' },
      email: { type: 'string', format: 'email', description: 'Lowercased. Unique per organisation.' },
      first_name: TEXT,
      last_name: TEXT,
      salutation: TEXT,
      honorific: TEXT,
      pronouns: TEXT,
      gender: TEXT,
      mobile_phone: TEXT,
      links: JSON_TEXT('{ linkedin, twitter, facebook, website }'),
      company: { type: ['string', 'null'], description: 'Per-event.' },
      job_title: { type: ['string', 'null'], description: 'Per-event.' },
      biography: { type: ['string', 'null'], description: 'Per-event.' },
      notes: { type: ['string', 'null'], description: 'Per-event, internal.' },
      headshot_asset_id: TEXT,
      source: { type: 'string', enum: ['import', 'cfp', 'admin', 'migration'], description: 'How they joined this event\'s roster.' },
      added_at: ISO,
      created_at: ISO,
      updated_at: ISO,
    },
  },

  ContactListRow: {
    allOf: [
      ref('Contact'),
      {
        type: 'object',
        description: 'List rows add derived columns the detail endpoint does not compute.',
        properties: {
          event_name: { type: 'string' },
          custom_fields_json: JSON_TEXT('{ <custom field key>: value } for this event, null when none are set'),
          confirmation: {
            type: ['string', 'null'],
            enum: ['confirmed', 'awaiting', null],
            description: 'Derived from participation: confirmed = at least one confirmed participant row; awaiting = a participant, none confirmed; null = not a participant at all (distinct from awaiting).',
          },
          speaker_status: {
            type: ['string', 'null'],
            description: 'The settable speaker workflow status; falls back to the confirmed/awaiting_reply derivation when nothing has been set by hand. Free vocabulary — not a closed enum.',
          },
        },
      },
    ],
  },

  Submission: {
    type: 'object',
    additionalProperties: true,
    description: 'A talk/abstract proposal. `status` is the pipeline state; approval, condition, revise and materials are independent FLAGS alongside it — read them, do not infer them from status.',
    properties: {
      id: { type: 'string' },
      event_id: { type: 'string' },
      code: { type: 'string', description: 'Human-facing reference, e.g. SESS-12. Unique within the event.' },
      kind: { type: 'string', enum: ['abstract', 'session'] },
      title: { type: 'string' },
      description: TEXT,
      status: { type: 'string', enum: list(SUBMISSION_STATUSES) },
      track_id: TEXT,
      format: TEXT,
      level: TEXT,
      language: TEXT,
      capacity: { type: ['integer', 'null'] },
      starts_at: { ...NULLABLE_ISO, description: 'Scheduled start, wall-clock in the EVENT timezone. null = unscheduled.' },
      ends_at: NULLABLE_ISO,
      room_id: TEXT,
      submitter_contact_id: TEXT,
      notified_at: { ...NULLABLE_ISO, description: 'When the decision letter went out. null = the speaker has not been told.' },
      evaluation_plan_id: TEXT,
      rating_cache: JSON_TEXT('{ "<evaluation_plan_id>": mean } — raw per-round means on each round\'s own scale'),
      approval_state: { type: ['string', 'null'], enum: [...list(APPROVAL_STATES), null], description: 'Employer approval. null = never asked.' },
      approval_note: TEXT,
      accept_condition: { type: ['string', 'null'], description: 'Free-text proviso on a conditional accept. Empty/null = unconditional.' },
      condition_met_at: { ...NULLABLE_ISO, description: 'null while the condition is outstanding — that pairing is the chase list.' },
      decision_outcome: { type: ['string', 'null'], enum: [...list(DECISION_OUTCOMES), null], description: 'The third outcome. A `revise` row KEEPS its declined/decline_queue status, so find it by this column, never by status.' },
      revise_guidance: TEXT,
      resubmission_of: TEXT,
      materials_state: { type: ['string', 'null'], enum: [...list(MATERIALS_STATES), null], description: 'Post-accept editorial state. null = nothing uploaded.' },
      materials_state_at: NULLABLE_ISO,
      content_approved: BOOL_INT('approved'),
      source: { type: 'string', enum: ['form', 'manual', 'import'] },
      notes: TEXT,
      extra: JSON_TEXT('importer/source passthrough'),
      created_at: ISO,
      updated_at: ISO,
    },
  },

  SubmissionListRow: {
    allOf: [
      ref('Submission'),
      {
        type: 'object',
        properties: {
          event_name: { type: 'string' },
          event_timezone: { type: 'string', description: 'Carried per row so a multi-event reader never has to look it up.' },
          track_name: TEXT,
          room_name: TEXT,
          plan_name: TEXT,
          submitter_name: TEXT,
          rating: {
            type: ['number', 'null'],
            description: 'Mean score normalised onto a common 1–5 display scale across every round the submission was scored in. null = never scored.',
          },
          review_count: { type: 'integer' },
        },
      },
    ],
  },

  SubmissionDetail: {
    allOf: [
      ref('Submission'),
      {
        type: 'object',
        description: 'The detail endpoint adds the joined children.',
        properties: {
          track_name: TEXT,
          plan_name: TEXT,
          form_name: TEXT,
          answers: {
            type: 'array',
            description: 'Form answers in question order. `value` is already parsed (string, number, array or object depending on the field type).',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, value: {} },
            },
          },
          participants: {
            type: 'array',
            items: ref('Participant'),
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag names, not ids.' },
          rating: { type: ['number', 'null'], description: 'Mean weighted_total over this event\'s rounds, 2dp. null = never scored.' },
          review_count: { type: 'integer' },
        },
      },
    ],
  },

  Participant: {
    type: 'object',
    properties: {
      contact_id: { type: 'string' },
      first_name: TEXT,
      last_name: TEXT,
      email: { type: 'string' },
      role: { type: 'string', enum: ['speaker', 'co-speaker', 'moderator', 'panelist'] },
      is_primary_contact: BOOL_INT('the primary contact for this submission'),
    },
  },

  Task: {
    type: 'object',
    additionalProperties: true,
    description: 'A task DEFINITION — the thing speakers get asked to do. Its per-person assignments are a separate resource (see the Tasks tag).',
    properties: {
      id: { type: 'string' },
      event_id: { type: 'string' },
      title: { type: 'string' },
      description: TEXT,
      target: { type: 'string', enum: ['contact', 'group', 'submission'] },
      assignment_mode: { type: 'string', enum: ['manual', 'automatic'] },
      trigger: { type: 'string', enum: ['on_accept', 'on_schedule', 'none'] },
      action_type: { type: 'string', enum: ['file_upload', 'portal_form', 'acknowledge', 'external_link'] },
      portal_form_id: TEXT,
      file_request_id: TEXT,
      due_at: NULLABLE_ISO,
      reminder_offsets_days: JSON_TEXT('int[] — days before due_at to remind'),
      required: BOOL_INT('required'),
      created_at: ISO,
      updated_at: NULLABLE_ISO,
    },
  },

  TaskAssignment: {
    type: 'object',
    additionalProperties: true,
    description: 'One person\'s copy of a task. This is what `GET /events/{event_id}/tasks` returns — `id` here is the ASSIGNMENT id and cannot be passed to the task write endpoints; use `task_id` for those.',
    properties: {
      id: { type: 'string', description: 'Assignment id.' },
      task_id: { type: 'string', description: 'The task definition — the id the PUT/DELETE task endpoints take.' },
      task_title: { type: 'string' },
      status: { type: 'string', enum: list(TASK_ASSIGNMENT_STATUSES) },
      completed_at: NULLABLE_ISO,
      due_at: { ...NULLABLE_ISO, description: 'Inherited from the task definition.' },
      required: BOOL_INT('required'),
      action_type: { type: 'string' },
      contact_id: { type: 'string' },
      assignee_name: TEXT,
      assignee_email: TEXT,
      submission_id: TEXT,
      submission_code: TEXT,
      submission_title: TEXT,
      event_id: { type: 'string' },
      event_name: { type: 'string' },
    },
  },

  Message: {
    type: 'object',
    additionalProperties: true,
    description: 'One outbound email, as logged. Read-only: this API sends nothing.',
    properties: {
      id: { type: 'string' },
      template_key: { type: ['string', 'null'], description: 'e.g. submission_confirmation, magic_link, task_reminder.' },
      to_email: { type: 'string' },
      contact_id: TEXT,
      contact_name: TEXT,
      subject: TEXT,
      status: { type: 'string', enum: list(MESSAGE_STATUSES) },
      body_html: TEXT,
      body_text: TEXT,
      error: { type: ['string', 'null'], description: 'Provider error, set when status is failed/bounced.' },
      created_at: ISO,
      sent_at: NULLABLE_ISO,
      event_id: { type: 'string' },
      event_name: { type: 'string' },
    },
  },

  Review: {
    type: 'object',
    additionalProperties: true,
    description: 'One reviewer\'s score for one submission in one round. Read-only.',
    properties: {
      id: { type: 'string' },
      submission_id: { type: 'string' },
      submission_code: { type: 'string' },
      submission_title: { type: 'string' },
      reviewer_contact_id: TEXT,
      reviewer_name: TEXT,
      plan_id: { type: 'string', description: 'The evaluation round.' },
      plan_name: TEXT,
      weighted_total: {
        type: ['number', 'null'],
        description: 'On THIS round\'s own scale (scoring_scale_min..max), not normalised — do not average across rounds without rescaling.',
      },
      scores: JSON_TEXT('{ "<criterion_id>": score }'),
      comment: TEXT,
      conflict_of_interest: BOOL_INT('the reviewer declared a conflict and did not score'),
      created_at: ISO,
      event_id: { type: 'string' },
      event_name: { type: 'string' },
    },
  },

  Comment: {
    type: 'object',
    additionalProperties: true,
    description: 'A committee comment on a submission. Read-only.',
    properties: {
      id: { type: 'string' },
      submission_id: { type: 'string' },
      submission_code: { type: 'string' },
      submission_title: { type: 'string' },
      plan_id: TEXT,
      assignment_id: TEXT,
      author_contact_id: TEXT,
      author_role: TEXT,
      author_name: TEXT,
      kind: { type: 'string', enum: list(COMMENT_KINDS), description: 'rationale = written when saving scores; discussion = a thread reply.' },
      body: { type: 'string' },
      created_at: ISO,
      event_id: { type: 'string' },
      event_name: { type: 'string' },
    },
  },

  FormSummary: {
    type: 'object',
    additionalProperties: true,
    description: 'A submission (CFP) form, list shape.',
    properties: {
      id: { type: 'string' },
      internal_name: { type: 'string', description: 'Organiser-facing name.' },
      external_title: TEXT,
      collection_type: { type: 'string', enum: ['abstracts', 'sessions'] },
      status: { type: 'string', enum: ['open', 'closed'] },
      close_at: NULLABLE_ISO,
      question_count: { type: 'integer' },
      submission_count: { type: 'integer' },
      created_at: ISO,
      updated_at: ISO,
    },
  },

  FormDetail: {
    allOf: [
      ref('FormSummary'),
      {
        type: 'object',
        properties: {
          page_heading: TEXT,
          welcome_message: TEXT,
          success_message: TEXT,
          submission_limit: { type: ['integer', 'null'], description: 'null = inherit the event default.' },
          collect_participants: BOOL_INT('the form collects co-speakers'),
          routing_rules: JSON_TEXT('RoutingRule[]'),
          cross_field_limits: JSON_TEXT('cross-field character limits'),
          notify_admins_on_create: JSON_TEXT('contact id[]'),
          notify_admins_on_update: JSON_TEXT('contact id[]'),
          participant_roles: JSON_TEXT('role[] offered by this form'),
          questions: { type: 'array', items: ref('FormQuestion') },
        },
      },
    ],
  },

  FormQuestion: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      form_id: { type: 'string' },
      section: { type: 'string', enum: ['abstract', 'participant'] },
      field_id: { type: 'string', description: 'The underlying field definition — the answer label a submission returns comes from here.' },
      label: TEXT,
      help_text: TEXT,
      position: { type: 'integer' },
      required: BOOL_INT('required'),
      locked: BOOL_INT('locked (cannot be removed from the form)'),
      options: JSON_TEXT('[{ value, label, color? }]'),
      max_chars: { type: ['integer', 'null'] },
      visibility: JSON_TEXT('ConditionalRule — when this question is shown'),
    },
  },

  DeleteResult: {
    type: 'object',
    properties: { ok: { type: 'boolean', enum: [true] } },
  },

  StatusResult: {
    type: 'object',
    properties: { ok: { type: 'boolean', enum: [true] }, status: { type: 'string', enum: list(SUBMISSION_STATUSES) } },
  },
};

/** The list envelope, parameterised by the row schema. */
const listEnvelope = (rowRef: unknown) => ({
  type: 'object',
  required: ['data', 'total', 'limit', 'has_more'],
  properties: {
    data: { type: 'array', items: rowRef },
    total: { type: 'integer', description: 'Rows matching the filters, ignoring pagination.' },
    limit: { type: 'integer' },
    offset: { type: ['integer', 'null'], description: 'null in cursor mode.' },
    has_more: { type: 'boolean' },
    next_cursor: {
      type: ['string', 'null'],
      description: 'Pass back as ?cursor= for the next page; null on the last page. Always null in offset mode.',
    },
  },
});

/** resource name → the schema its list rows use, and the tag/operation naming. */
const ROW_SCHEMA: Record<string, string> = {
  contacts: 'ContactListRow',
  submissions: 'SubmissionListRow',
  tasks: 'TaskAssignment',
  messages: 'Message',
  reviews: 'Review',
  comments: 'Comment',
};

/** Per-resource notes that only make sense on the list operation. */
const RESOURCE_NOTES: Record<string, string> = {
  tasks:
    'Rows are task ASSIGNMENTS (one per person per task), not task definitions. `id` is the assignment id; `task_id` is what the task write endpoints take.',
  reviews:
    'One row per reviewer per submission per round. `weighted_total` is on that round\'s own scale — use the submission list\'s `rating` for a cross-round number.',
  comments: 'Committee comments. `kind: rationale` rows are the note a reviewer left when saving scores.',
  messages: 'The outbound email log. This API cannot send mail; it can only read what was sent.',
  contacts: 'One row per person per event roster. A person on three events has three rows, each with its own company/job_title/biography.',
  submissions: 'The CFP pipeline. Filter on the flag columns (approval_state, decision_outcome, materials_state, has_condition) rather than reading them out of `status`.',
};

/**
 * Filters whose query-string form needs a tighter schema than "string", and the
 * two that cannot be expressed in a query string at all. Vocabularies are
 * imported from the modules that enforce them, so an enum here cannot drift.
 */
const FILTER_HINTS: Record<string, { schema?: Record<string, unknown>; unavailable?: string }> = {
  'submissions.status': { schema: { type: 'string', enum: list(SUBMISSION_STATUSES) } },
  'submissions.approval_state': { schema: { type: 'string', enum: [...list(APPROVAL_STATES), 'none'] } },
  'submissions.materials_state': { schema: { type: 'string', enum: [...list(MATERIALS_STATES), 'none'] } },
  'submissions.decision_outcome': { schema: { type: 'string', enum: [...list(DECISION_OUTCOMES), 'none'] } },
  'submissions.min_reviews': { schema: { type: 'integer', minimum: 0 } },
  'submissions.max_reviews': { schema: { type: 'integer', minimum: 0 } },
  'tasks.status': { schema: { type: 'string', enum: list(TASK_ASSIGNMENT_STATUSES) } },
  'messages.status': { schema: { type: 'string', enum: list(MESSAGE_STATUSES) } },
  'comments.kind': { schema: { type: 'string', enum: list(COMMENT_KINDS) } },
  'contacts.confirmation': { schema: { type: 'string', enum: ['confirmed', 'awaiting'] } },
  // Registry filters that exist for the admin SPA's JSON query body only.
  'contacts.contact_ids': { unavailable: 'takes an array, which a query string cannot carry' },
  'contacts.events': { unavailable: 'applies only to the SPA\'s organisation-directory mode, which this surface does not expose' },
};

const titleCase = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function buildOpenApi(origin: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const resourceNames = Object.keys(RESOURCES);

  // Merge rather than assign: the write operations below share a path with the
  // registry-generated list ones (`POST /contacts` and `GET /contacts` are one
  // path item), and a plain assignment silently drops whichever came first.
  const addOps = (path: string, ops: Record<string, unknown>) => {
    paths[path] = { ...(paths[path] ?? {}), ...ops };
  };

  paths['/openapi.json'] = {
    get: {
      operationId: 'getOpenApiDocument',
      summary: 'This document',
      description: 'The spec itself, generated live from the running registry. Public — no credential needed, so a client can discover the surface before it has a token.',
      tags: ['Discovery'],
      security: [],
      responses: { '200': json({ type: 'object' }, 'The OpenAPI 3.1 document.') },
    },
  };

  paths['/events'] = {
    get: {
      operationId: 'listEvents',
      summary: 'List accessible events',
      description:
        'Start here. Every event the credential can reach — the whole organisation for a bearer token, exactly one for a first-party session. Every other path needs an `event_id` from this list. Not paginated.',
      tags: ['Events'],
      responses: {
        '200': json({ type: 'object', properties: { data: { type: 'array', items: ref('Event') } } }, 'Events, earliest start first.'),
        '401': responseRef('Unauthorized'),
      },
    },
  };

  paths['/events/{event_id}'] = {
    get: {
      operationId: 'getEvent',
      summary: 'Get one event',
      description: 'Chiefly useful for `timezone` — scheduled times on submissions are wall-clock in it.',
      tags: ['Events'],
      parameters: [paramRef('EventId')],
      responses: {
        '200': json(ref('Event'), 'The event.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('EventNotFound'),
      },
    },
  };

  for (const [name, def] of Object.entries(RESOURCES)) {
    const tag = titleCase(name);
    const Name = titleCase(name);
    // A resource added to the registry without a schema here still documents
    // itself, just with an open row shape rather than a dangling $ref.
    const rowSchema = ROW_SCHEMA[name];
    const rowRef = rowSchema ? ref(rowSchema) : { type: 'object', additionalProperties: true };

    const filterParams = Object.keys(def.filters)
      .filter((filter) => !FILTER_HINTS[`${name}.${filter}`]?.unavailable)
      .map((filter) => {
        const doc = def.filterDocs[filter] ?? '';
        const hint = FILTER_HINTS[`${name}.${filter}`]?.schema;
        // filterDocs opens with "true →" exactly when the filter is a flag.
        const schema = hint ?? (doc.startsWith('true →') ? { type: 'boolean' } : { type: 'string' });
        return { name: filter, in: 'query', required: false, description: doc, schema };
      });

    const unavailable = Object.keys(def.filters)
      .map((filter) => [filter, FILTER_HINTS[`${name}.${filter}`]?.unavailable] as const)
      .filter(([, why]) => why);

    const sortValues = Object.keys(def.sortable).flatMap((f) => [f, `-${f}`]);
    const sortParam = {
      name: 'sort',
      in: 'query',
      required: false,
      description: `Sort field; prefix with "-" for descending. An unrecognised value is ignored (offset mode falls back to the resource default, cursor mode to id order) rather than erroring.`,
      schema: { type: 'string', enum: sortValues },
      example: sortValues[1],
    };

    const description = [
      RESOURCE_NOTES[name] ?? '',
      '',
      'Filterable, sortable, paginated. Filters combine with AND; an unknown filter name is ignored, never an error — check `total` if you are unsure a filter applied. The admin workspace runs this exact query, so what you read here is what an organiser sees.',
      unavailable.length > 0
        ? `\nNot available over HTTP: ${unavailable.map(([f, why]) => `\`${f}\` (${why})`).join('; ')}.`
        : '',
    ]
      .join('\n')
      .trim();

    paths[`/events/{event_id}/${name}`] = {
      get: {
        operationId: `list${Name}`,
        summary: `List ${name}`,
        description,
        tags: [tag],
        parameters: [paramRef('EventId'), ...filterParams, sortParam, paramRef('Cursor'), paramRef('Limit'), paramRef('Offset')],
        responses: {
          '200': json(listEnvelope(rowRef), `${tag} rows.`),
          '400': responseRef('InvalidCursor'),
          '401': responseRef('Unauthorized'),
          '403': responseRef('Forbidden'),
          '404': responseRef('EventNotFound'),
        },
      },
    };

    paths[`/events/{event_id}/${name}/export`] = {
      get: {
        operationId: `export${Name}`,
        summary: `Export ${name} (CSV/XLSX)`,
        description:
          'Byte-for-byte the file the workspace export button produces, honouring the same filters — the right endpoint when a human wants the result, and a poor one when your code wants the data (use the list endpoint, which paginates and returns JSON). Up to 10,000 rows; no pagination. Submissions gain a derived `outcome` column and reviews readable criterion names, so the file is not simply the list rows as CSV.',
        tags: [tag],
        parameters: [
          paramRef('EventId'),
          ...filterParams,
          { name: 'format', in: 'query', required: false, description: 'csv (default) or xlsx.', schema: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' } },
          { name: 'sort', in: 'query', required: false, description: 'Same vocabulary as the list endpoint.', schema: { type: 'string', enum: sortValues } },
          { name: 'limit', in: 'query', required: false, description: 'Row cap, 1–10000. Default 10000.', schema: { type: 'integer', minimum: 1, maximum: 10000 } },
        ],
        responses: {
          '200': {
            description: 'The file, as an attachment (Content-Disposition names it `<event-slug>-<resource>-<date>.<ext>`).',
            content: {
              'text/csv': { schema: { type: 'string' } },
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '401': responseRef('Unauthorized'),
          '403': responseRef('Forbidden'),
          '404': responseRef('EventNotFound'),
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Submissions: detail + writes
  // -------------------------------------------------------------------------

  const submissionWriteBody = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Required on create; must be non-empty.' },
      description: { type: ['string', 'null'] },
      format: { type: ['string', 'null'] },
      level: { type: ['string', 'null'] },
      language: { type: ['string', 'null'] },
      track_id: { type: ['string', 'null'], description: 'Must belong to this event, else 400. null clears it.' },
      status: { type: 'string', enum: list(SUBMISSION_STATUSES), description: 'Update only — ignored on create, which always starts `pending`.' },
    },
    additionalProperties: false,
    description: 'Only these fields are writable. Anything else in the body is ignored — the schedule, decision flags, answers and participants are not settable through this API. Tags have their own endpoint (PUT /events/{event_id}/submissions/{id}/tags).',
  };

  addOps('/events/{event_id}/submissions', {
    post: {
      operationId: 'createSubmission',
      summary: 'Create a submission (manual)',
      description:
        'An admin-authored proposal, not one that came through a public form. `status` starts `pending`, `source` is `manual`, and `code` is allocated as SESS-<n> by the same allocator the rest of the app uses. Answers and participants cannot be attached here — a submission that needs them belongs on a form. Tags go on afterwards with PUT /events/{event_id}/submissions/{id}/tags.',
      tags: ['Submissions'],
      parameters: [paramRef('EventId'), paramRef('IdempotencyKey')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: submissionWriteBody,
            example: { title: 'Shipping on Fridays', description: 'A field report.', format: 'talk', level: 'intermediate' },
          },
        },
      },
      responses: {
        '201': json(ref('Submission'), 'Created.', replayHeader),
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('EventNotFound'),
        '422': responseRef('IdempotencyMismatch'),
      },
    },
  });

  addOps('/events/{event_id}/submissions/{id}', {
    get: {
      operationId: 'getSubmission',
      summary: 'Get one submission',
      description: 'The full record — parsed form answers, participants, tags and the review summary. This is the same shape the workspace detail tab renders, and the only place answers and participants are exposed.',
      tags: ['Submissions'],
      parameters: [paramRef('EventId'), idParam('submission')],
      responses: {
        '200': json(ref('SubmissionDetail'), 'The submission.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
    put: {
      operationId: 'updateSubmission',
      summary: 'Update a submission',
      description: 'Sparse: only the fields present in the body change. Unlike the status endpoint below this also accepts `status`, with the same no-email guarantee.',
      tags: ['Submissions'],
      parameters: [paramRef('EventId'), idParam('submission')],
      requestBody: { required: true, content: { 'application/json': { schema: submissionWriteBody, example: { level: 'advanced' } } } },
      responses: {
        '200': json(ref('Submission'), 'Updated.'),
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
    delete: {
      operationId: 'deleteSubmission',
      summary: 'Delete a submission',
      description: 'Irreversible, and it cascades: answers, participants, tags, reviews, comments and task assignments go with it. To take a proposal out of consideration without destroying the record, set status `withdrawn` instead.',
      tags: ['Submissions'],
      parameters: [paramRef('EventId'), idParam('submission')],
      responses: {
        '200': json(ref('DeleteResult'), 'Deleted.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
  });

  addOps('/events/{event_id}/submissions/{id}/status', {
    post: {
      operationId: 'setSubmissionStatus',
      summary: 'Change a submission status',
      description:
        'Moves a submission between pipeline states. Decision emails are deliberately NOT sent from here — batch notification stays in the app (Evaluation → send decisions), so an API status change never mails a speaker by surprise. Setting `accepted` therefore does not tell anyone they were accepted.',
      tags: ['Submissions'],
      parameters: [paramRef('EventId'), idParam('submission'), paramRef('IdempotencyKey')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: list(SUBMISSION_STATUSES) } },
              additionalProperties: false,
            },
            example: { status: 'accept_queue' },
          },
        },
      },
      responses: {
        '200': json(ref('StatusResult'), 'Updated.', replayHeader),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
        '422': json(ref('Error'), 'Invalid status value (`invalid_status`), or this Idempotency-Key was already used with a different body (`idempotency_mismatch`).'),
      },
    },
  });

  addOps('/events/{event_id}/submissions/{id}/tags', {
    put: {
      operationId: 'setSubmissionTags',
      summary: "Replace a submission's tags",
      description:
        'Tags by NAME, matched case-insensitively — the same strings the detail GET returns, so you can read a submission, add one to the list you got back, and send it. Whole-set replace: what you send is exactly what the submission ends up carrying, and an empty array clears it. A name the event does not have is refused (422 `unknown_tag`) rather than silently dropped or silently created; send `create_missing: true` when you do mean to coin one. GET /events/{event_id}/tags lists the vocabulary.',
      tags: ['Submissions'],
      parameters: [paramRef('EventId'), idParam('submission')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tags'],
              properties: {
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tag names. Duplicates (case-insensitively) collapse; at most 100.',
                },
                create_missing: {
                  type: 'boolean',
                  description: 'Create any name this event does not have yet, instead of refusing. Default false.',
                },
              },
              additionalProperties: false,
            },
            example: { tags: ['needs AV', 'first-time speaker'] },
          },
        },
      },
      responses: {
        '200': json(
          {
            type: 'object',
            properties: { ok: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } },
          },
          'The stored set, in name order.',
        ),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
        '422': json(ref('Error'), 'A name this event does not have (`unknown_tag`), or a malformed list (`invalid_tags`).'),
      },
    },
  });

  addOps('/events/{event_id}/tags', {
    get: {
      operationId: 'listTags',
      summary: "List the event's tags",
      description:
        "The event's tag vocabulary in name order — the names the submission tags endpoint accepts. Tags are labels that cut across tracks; they are created in the app's Settings, by an import, or by a tags write sending `create_missing`.",
      tags: ['Submissions'],
      parameters: [paramRef('EventId')],
      responses: {
        '200': json(
          {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    color: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
          'The tags.',
        ),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('EventNotFound'),
      },
    },
  });

  // -------------------------------------------------------------------------
  // Contacts: detail + writes
  // -------------------------------------------------------------------------

  const contactBody = {
    type: 'object',
    additionalProperties: false,
    description: 'The writable fields. The body is flat, but the two halves land in different places: identity is shared across the organisation, profile is recorded against this event only.',
    properties: {
      email: {
        type: 'string',
        format: 'email',
        description:
          'Required on create; lowercased. Unique per ORGANISATION, not per event — one person, every event. Creating with an email already on THIS event is 409 `email_exists`; an email known to the org but not this event attaches that existing person to this event instead of creating a duplicate.',
      },
      first_name: { type: ['string', 'null'] },
      last_name: { type: ['string', 'null'] },
      mobile_phone: { type: ['string', 'null'] },
      pronouns: { type: ['string', 'null'] },
      company: { type: ['string', 'null'], description: 'Per-event.' },
      job_title: { type: ['string', 'null'], description: 'Per-event.' },
      biography: { type: ['string', 'null'], description: 'Per-event.' },
    },
  };

  addOps('/events/{event_id}/contacts', {
    post: {
      operationId: 'createContact',
      summary: 'Create a contact, or add an existing one to this event',
      description:
        'Idempotent in spirit as well as by header: if the organisation already knows this email, the existing person is attached to this event rather than duplicated, their per-event profile seeded from their most recent other event, and supplied identity fields only fill blanks.',
      tags: ['Contacts'],
      parameters: [paramRef('EventId'), paramRef('IdempotencyKey')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: contactBody,
            example: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', company: 'Analytical Engines' },
          },
        },
      },
      responses: {
        '201': json(ref('Contact'), 'Created, or an existing organisation contact added to this event.', replayHeader),
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('EventNotFound'),
        '409': json(ref('Error'), 'A contact with this email is already on this event (`email_exists`).'),
        '422': responseRef('IdempotencyMismatch'),
      },
    },
  });

  addOps('/events/{event_id}/contacts/{id}', {
    get: {
      operationId: 'getContact',
      summary: 'Get one contact',
      description: 'The roster row: org-level identity merged with this event\'s profile.',
      tags: ['Contacts'],
      parameters: [paramRef('EventId'), idParam('contact')],
      responses: {
        '200': json(ref('Contact'), 'The contact.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
    put: {
      operationId: 'updateContact',
      summary: 'Update a contact',
      description:
        'Sparse. Careful: identity fields (email, name, phone, pronouns) are organisation-level, so changing them here changes them on every event this person appears on. Profile fields (company, job_title, biography) touch this event only.',
      tags: ['Contacts'],
      parameters: [paramRef('EventId'), idParam('contact')],
      requestBody: { required: true, content: { 'application/json': { schema: contactBody, example: { job_title: 'Head of Engines' } } } },
      responses: {
        '200': json(ref('Contact'), 'Updated.'),
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
        '409': json(ref('Error'), 'Another contact in this organisation already uses this email (`email_exists`).'),
      },
    },
    delete: {
      operationId: 'removeContactFromEvent',
      summary: 'Remove a contact from this event',
      description:
        'Detach, not destroy: this event\'s membership and per-event profile go, the person and their history at the organisation\'s other events stay. Only when this was their last event is the person deleted outright. A remaining reference (say a reviewer assignment) is a 409, not a 500.',
      tags: ['Contacts'],
      parameters: [paramRef('EventId'), idParam('contact')],
      responses: {
        '200': json(ref('DeleteResult'), 'Detached (and deleted, if it was their last event).'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
        '409': json(ref('Error'), 'Other records still reference this contact (`constraint`).'),
      },
    },
  });

  // -------------------------------------------------------------------------
  // Tasks (definitions). The list/export endpoints under the same tag return
  // ASSIGNMENTS — see the tag description.
  // -------------------------------------------------------------------------

  const taskBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Required on create.' },
      description: { type: ['string', 'null'] },
      target: { type: 'string', enum: ['contact', 'group', 'submission'], description: 'What the task hangs off. Default contact.' },
      assignment_mode: { type: 'string', enum: ['manual', 'automatic'], description: 'automatic = assigned by the trigger; manual = assigned by hand in the app. Default manual.' },
      trigger: { type: 'string', enum: ['on_accept', 'on_schedule', 'none'], description: 'When automatic assignment fires. Default none.' },
      action_type: { type: 'string', enum: ['file_upload', 'portal_form', 'acknowledge', 'external_link'], description: 'What the assignee does. Default acknowledge.' },
      portal_form_id: { type: ['string', 'null'], description: 'Must belong to this event. Required in practice when action_type is portal_form.' },
      file_request_id: { type: ['string', 'null'], description: 'Must belong to this event. Required in practice when action_type is file_upload.' },
      due_at: { type: ['string', 'null'], format: 'date-time', description: 'ISO 8601.' },
      reminder_offsets_days: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Days before due_at to remind, e.g. [14, 3]. Sent as a real array here; read back as a JSON string.' },
      required: { type: 'boolean' },
    },
  };

  addOps('/events/{event_id}/tasks', {
    post: {
      operationId: 'createTask',
      summary: 'Create a task definition',
      description:
        'Creates the task itself. It has no assignees yet — assigning people to it is an admin-app action, so a task created here shows up in the workspace but sends nothing until someone assigns or a trigger fires. Note the asymmetry with `GET /events/{event_id}/tasks`, which lists assignments.',
      tags: ['Tasks'],
      parameters: [paramRef('EventId'), paramRef('IdempotencyKey')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: taskBody,
            example: { title: 'Upload your slides', action_type: 'file_upload', trigger: 'on_accept', due_at: '2026-09-01T00:00:00.000Z', reminder_offsets_days: [14, 3], required: true },
          },
        },
      },
      responses: {
        '201': json(ref('Task'), 'Created.', replayHeader),
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('EventNotFound'),
        '422': responseRef('IdempotencyMismatch'),
      },
    },
  });

  addOps('/events/{event_id}/tasks/{id}', {
    put: {
      operationId: 'updateTask',
      summary: 'Update a task definition',
      description: 'Sparse. `id` here is a TASK id (`task_id` on an assignment row), not an assignment id.',
      tags: ['Tasks'],
      parameters: [paramRef('EventId'), idParam('task')],
      requestBody: { required: true, content: { 'application/json': { schema: taskBody, example: { due_at: '2026-09-15T00:00:00.000Z' } } } },
      responses: {
        '200': json(ref('Task'), 'Updated.'),
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
    delete: {
      operationId: 'deleteTask',
      summary: 'Delete a task definition',
      description: 'Every assignment of this task cascades away with it, including completed ones.',
      tags: ['Tasks'],
      parameters: [paramRef('EventId'), idParam('task')],
      responses: {
        '200': json(ref('DeleteResult'), 'Deleted.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
  });

  // -------------------------------------------------------------------------
  // Forms: read-only in v1 preview.
  // -------------------------------------------------------------------------

  paths['/events/{event_id}/forms'] = {
    get: {
      operationId: 'listForms',
      summary: 'List submission forms',
      description: 'The CFP forms for this event, newest first, with question and submission counts. Read-only: building and editing forms stays in the admin app. Not paginated.',
      tags: ['Forms'],
      parameters: [paramRef('EventId')],
      responses: {
        '200': json({ type: 'object', properties: { data: { type: 'array', items: ref('FormSummary') } } }, 'Forms.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('EventNotFound'),
      },
    },
  };

  paths['/events/{event_id}/forms/{id}'] = {
    get: {
      operationId: 'getForm',
      summary: 'Get one form',
      description: 'The form plus its questions in display order. Read this to learn what the `answers` on a submission mean — the answer labels come from these questions.',
      tags: ['Forms'],
      parameters: [paramRef('EventId'), idParam('form')],
      responses: {
        '200': json(ref('FormDetail'), 'The form.'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '404': responseRef('NotFound'),
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'KMS API (v1 preview)',
      version: '1.0.0-preview',
      summary: 'Conference and CFP management: submissions, speakers, review scores, speaker tasks and the email log.',
      description: agentPreamble(origin, resourceNames),
    },
    servers: [{ url: `${origin}/api/v1`, description: 'This deployment.' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Discovery', description: 'Unauthenticated self-description.' },
      { name: 'Events', description: 'The scope of everything else. Get an event id here first.' },
      { name: 'Submissions', description: 'Talk proposals and their pipeline: list/filter, full detail with answers and participants, create, update, delete, and status changes (which never send email).' },
      { name: 'Contacts', description: 'People on an event roster — speakers, reviewers, staff. Identity is organisation-wide, profile is per-event.' },
      {
        name: 'Tasks',
        description:
          'Two different things share this tag, deliberately mirroring the data model: the LIST and EXPORT operations return task ASSIGNMENTS (one row per person per task, with `task_id` pointing at the definition), while POST/PUT/DELETE act on task DEFINITIONS. Assigning a person to a task is not exposed here.',
      },
      { name: 'Reviews', description: 'Committee scores, read-only. Scores are per round and on that round\'s own scale.' },
      { name: 'Comments', description: 'Committee discussion and reviewer rationales, read-only.' },
      { name: 'Messages', description: 'The outbound email log, read-only. Nothing on this surface sends mail.' },
      { name: 'Forms', description: 'CFP form definitions and their questions, read-only.' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API token from Settings → API tokens (`kms_…`), scoped to one organisation. First-party browser callers may use the admin session cookie instead, which is scoped to a single event.',
        },
      },
      parameters: {
        EventId: {
          name: 'event_id',
          in: 'path',
          required: true,
          description: 'The event to operate on, from `GET /events`. Tokens are organisation-scoped, so the event always travels in the path — there is no "current event" server-side state.',
          schema: { type: 'string' },
        },
        Cursor: {
          name: 'cursor',
          in: 'query',
          required: false,
          description:
            'Opt into keyset pagination, which is stable under concurrent inserts and deletes and is what you want for any loop over a whole resource. Send it EMPTY for the first page, then pass the previous response\'s `next_cursor`; stop when `next_cursor` is null. Limit caps at 100 in this mode and `offset` comes back null. Omitting the parameter entirely selects legacy offset mode.',
          schema: { type: 'string' },
          example: '',
        },
        Limit: {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Page size. 1–200 in offset mode, 1–100 in cursor mode; out-of-range values clamp rather than error. Default 25.',
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        },
        Offset: {
          name: 'offset',
          in: 'query',
          required: false,
          description: 'Rows to skip. Offset mode only — ignored, and echoed back as null, when `cursor` is used. Default 0.',
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description:
            'Replay-safe retries on POST (PUT and DELETE ignore it). A repeated key, scoped to this credential, returns the original response verbatim with `Idempotency-Replayed: true` instead of executing again; the same key with a different body is 422 `idempotency_mismatch`. Stored 24h, for 2xx and 4xx outcomes alike — so a retried validation error replays as that same error.',
          schema: { type: 'string' },
        },
      },
      responses: {
        Unauthorized: json(ref('Error'), 'Missing, malformed or revoked credentials (`unauthenticated`, `invalid_token`).'),
        Forbidden: json(ref('Error'), 'The credential is valid but cannot reach this event (`forbidden`).'),
        EventNotFound: json(ref('Error'), 'No event with this id (`event_not_found`), or — on a list path — no such resource (`unknown_resource`; the message lists the valid names).'),
        NotFound: json(ref('Error'), 'No record with this id in this event (`not_found`). Note the scoping: a real id belonging to another event reads as not found, never as forbidden.'),
        InvalidCursor: json(ref('Error'), 'The `cursor` value is not a cursor this API issued (`invalid_cursor`). Restart the walk with an empty cursor.'),
        ValidationError: json(ref('Error'), 'A field failed validation (`validation`). `error.details[]` names each offending field.'),
        IdempotencyMismatch: json(ref('Error'), 'This Idempotency-Key was already used with a different request body (`idempotency_mismatch`).'),
      },
      schemas,
    },
    paths,
  };
}

/** The orientation an agent needs before its first call: what this is, how to
 * page, what the shapes do that will surprise you, and what is absent — so
 * nobody spends three requests discovering there are no webhooks. */
function agentPreamble(origin: string, resources: string[]): string {
  return [
    'Conference and call-for-papers management. Organisers collect talk proposals through forms, a committee scores them, decisions go out, and accepted speakers get tasks (slides, headshots, consent).',
    '',
    '## Scope model',
    '',
    'A bearer token belongs to one **organisation**; an organisation runs many **events**; every path below names its event explicitly. There is no server-side "current event" — start with `GET /events`, keep the id, put it in every subsequent path.',
    '',
    '## Quickstart',
    '',
    '```bash',
    `curl -H "Authorization: Bearer kms_…" "${origin}/api/v1/events"`,
    `curl -H "Authorization: Bearer kms_…" \\`,
    `  "${origin}/api/v1/events/EVENT_ID/submissions?status=pending&sort=-created_at&limit=50"`,
    '```',
    '',
    'Create a token under **Settings → API tokens** in the admin app.',
    '',
    '## Reading a whole resource',
    '',
    'Send `cursor=` (empty) on the first request, then pass the `next_cursor` from each response back as `cursor`, stopping when it is null. This is stable while other people are editing; offset paging (`limit`/`offset`, used when you omit `cursor` entirely) is not.',
    '',
    '## Conventions worth knowing before you parse anything',
    '',
    `- **Resources.** ${resources.map((r) => `\`${r}\``).join(', ')} all support list + export with the same grammar. Full detail endpoints exist for **submissions and contacts only**; the others are list-shaped or nothing.`,
    '- **Envelope.** Lists return `{ data, total, limit, offset, has_more, next_cursor }`. Single records are returned bare, not wrapped.',
    '- **Errors.** `{ "error": { "code", "message", "details"? } }`. Branch on `code`; `message` is prose and may change.',
    '- **Unknown filters are ignored, never rejected.** A typo silently returns unfiltered rows, so compare `total` against expectations rather than trusting that a filter applied.',
    '- **JSON columns come back as strings.** `scores`, `links`, `options`, `routing_rules`, `rating_cache`, `reminder_offsets_days` and friends are stored as text and returned as text; parse them yourself.',
    '- **Booleans are 0/1 integers** in row data (they are real booleans in request bodies).',
    '- **Timestamps are UTC ISO 8601 strings**, except submission `starts_at`/`ends_at`, which are wall-clock in the event\'s timezone.',
    '- **Flags are not statuses.** A `revise` decision keeps a `declined` status; employer approval, accept conditions and materials progress are all separate columns. Filter on the flag.',
    '- **Retries.** POST accepts `Idempotency-Key`. PUT is naturally idempotent; DELETE returns 404 the second time.',
    '- **CORS** is open (`*`) — tokens are sent explicitly and no cookie is involved, so browser callers are fine.',
    '- **No rate limit** is enforced today. Do not take that as licence to hammer it.',
    '',
    '## What this API will not do',
    '',
    'Knowing the holes up front is cheaper than discovering them:',
    '',
    '- **It never sends email.** Changing a submission to `accepted` does not notify the speaker; decision batches are sent from the admin app deliberately, so an automated status change cannot mail hundreds of people by mistake.',
    '- **No webhooks or events stream.** Poll a list sorted by `-updated_at` if you need to notice changes.',
    '- **No writes** for reviews, comments, forms, form questions, participants, tags, answers, schedule/agenda, or task assignment. Those surfaces are read-only or admin-app-only.',
    '- **No sparse fieldsets, no multi-field sort, no `OR` across filters, no full-text search beyond each resource\'s `q`.**',
    '- **No bulk endpoints.** Write one record per request.',
    '',
    'See docs/10-api.md §6 for the full backlog behind these gaps.',
  ].join('\n');
}

/**
 * `/llms.txt` (llmstxt.org): the one file an agent is expected to fetch when it
 * lands on a host knowing nothing. It is not a second copy of the API reference
 * — that is what the OpenAPI document is for, and this exists to hand over its
 * URL along with the handful of facts needed to use it: the base URL, how to
 * authenticate, where to start, and what the surface deliberately will not do.
 *
 * Markdown by convention: H1, a blockquote summary, free prose, then H2-titled
 * lists of links. Generated rather than static so the URLs are this
 * deployment's, whichever host it is reached on.
 */
export function llmsTxt(origin: string): string {
  const api = `${origin}/api/v1`;
  const resources = Object.keys(RESOURCES);

  return [
    '# KMS — conference and call-for-papers management',
    '',
    '> A REST API for running a conference programme: collecting talk proposals through call-for-papers forms, scoring them with a review committee, deciding and scheduling them, and chasing accepted speakers for their slides, headshots and consent. Read/write JSON over HTTPS.',
    '',
    `- **API base URL:** \`${api}\``,
    `- **OpenAPI 3.1 description:** \`${api}/openapi.json\` — public, no credential needed`,
    '- **Authentication:** `Authorization: Bearer kms_…`, an organisation-scoped token created under Settings → API tokens in the admin app',
    '',
    'A token belongs to one organisation; an organisation runs many events; every path names its event explicitly, so there is no server-side "current event". Start by listing events, keep the id, and put it in every subsequent path:',
    '',
    '```bash',
    `curl -H "Authorization: Bearer kms_…" "${api}/events"`,
    `curl -H "Authorization: Bearer kms_…" \\`,
    `  "${api}/events/EVENT_ID/submissions?status=pending&sort=-created_at&limit=50"`,
    '```',
    '',
    `Listable, filterable, exportable resources: ${resources.map((r) => `\`${r}\``).join(', ')}. Each supports the same grammar — named filters, \`sort\` (prefix \`-\` to reverse), and either keyset pagination (send \`cursor=\` empty, then follow \`next_cursor\`) or offset pagination (\`limit\`/\`offset\`). Full detail endpoints exist for submissions and contacts; writes exist for submissions, contacts and task definitions.`,
    '',
    'Read the OpenAPI document for the field-level detail. Five things in it are worth knowing before you write any parsing code:',
    '',
    "- **A submission's tags are written by name, through their own endpoint** (`PUT /events/{event_id}/submissions/{id}/tags`) — the same strings the detail endpoint returns. It replaces the whole set, and refuses a name the event does not have unless you send `create_missing: true`.",
    '- **Changing a submission\'s status never emails anyone.** Decision batches are sent from the admin app on purpose, so an automated status change cannot notify hundreds of speakers by accident.',
    '- **Unknown filter names are ignored, never rejected** — a typo returns unfiltered rows, so check `total` rather than trusting that a filter applied.',
    '- **Decision flags are separate columns from `status`.** A "revise and resubmit" outcome keeps a `declined` status; employer approval, accept conditions and post-accept materials each have their own column. Filter on the flag.',
    '- **JSON columns come back as strings and booleans as `0`/`1`** in row data.',
    '',
    'There are no webhooks, no bulk endpoints, and no way to send email, create events, edit forms, or write reviews through this API.',
    '',
    '## API',
    '',
    `- [OpenAPI 3.1 specification](${api}/openapi.json): the complete machine-readable surface — every endpoint, filter, field and error code, generated live from the running server.`,
    `- [Interactive API reference](${origin}/docs): the same document rendered for humans.`,
    `- [Health check](${origin}/health): liveness, no authentication.`,
    '',
    '## Human interfaces',
    '',
    `- [Organiser workspace](${origin}/app): where staff run the event. Anything this API cannot do is done here, so it is the honest answer to "how do I …?" when no endpoint fits.`,
    `- [Event site](${origin}/): the public front page, including the published agenda. The speaker portal sits under \`${origin}/portal/<event-slug>\` — one address per event, reached by an emailed magic link rather than browsed to.`,
    '',
  ].join('\n');
}

/** Minimal /docs page: Scalar from CDN, with the raw JSON as a no-JS fallback. */
export function docsHtml(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KMS API docs</title>
</head>
<body>
  <noscript>JavaScript is off — read the raw spec at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</noscript>
  <div id="fallback" style="display:none;font-family:system-ui;padding:2rem">
    Docs renderer failed to load from CDN — the spec itself lives at
    <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.
  </div>
  <script id="api-reference" data-url="${origin}/api/v1/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference" onerror="document.getElementById('fallback').style.display='block'"></script>
</body>
</html>`;
}

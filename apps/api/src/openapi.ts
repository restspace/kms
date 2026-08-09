// OpenAPI 3.1 for /api/v1 (docs/10 §5). Generated at request time from the
// RESOURCES registry in adminApi.ts — filter names, their one-line semantics
// and the sortable fields come from the exact objects the query executor runs,
// so the document cannot describe an endpoint that does not exist.

import { RESOURCES } from './routes/adminApi';

const eventIdParam = {
  name: 'event_id',
  in: 'path',
  required: true,
  description: 'The event to operate on. Tokens are organisation-scoped; the event always travels in the path.',
  schema: { type: 'string' },
};

const idParam = (noun: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description: `The ${noun} id.`,
  schema: { type: 'string' },
});

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
});

const idempotencyKeyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Replay-safe retries. A repeated key (scoped to this credential) returns the original response verbatim ' +
    '(header `Idempotency-Replayed: true`) rather than re-executing; the same key with a different body is a ' +
    '422 idempotency_mismatch. Stored 24h, only for 2xx/4xx outcomes.',
  schema: { type: 'string' },
};

const idempotencyResponses = {
  '422': errorResponse('Same Idempotency-Key reused with a different request body.'),
};

export function buildOpenApi(origin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  paths['/events'] = {
    get: {
      summary: 'List accessible events',
      description: 'Every event the credential can reach — the whole organisation for a bearer token.',
      tags: ['Events'],
      responses: {
        '200': { description: 'Events.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
        '401': errorResponse('Missing or invalid credentials.'),
      },
    },
  };

  paths['/events/{event_id}'] = {
    get: {
      summary: 'Get one event',
      tags: ['Events'],
      parameters: [eventIdParam],
      responses: {
        '200': { description: 'The event.', content: { 'application/json': { schema: { type: 'object' } } } },
        '403': errorResponse('The credential cannot access this event.'),
        '404': errorResponse('No event with this id.'),
      },
    },
  };

  for (const [name, def] of Object.entries(RESOURCES)) {
    const filterParams = Object.keys(def.filters).map((filter) => {
      const doc = def.filterDocs[filter] ?? '';
      const boolean = doc.startsWith('true →');
      return {
        name: filter,
        in: 'query',
        required: false,
        description: doc,
        schema: boolean ? { type: 'boolean' } : { type: 'string' },
      };
    });
    const listParams = [
      eventIdParam,
      ...filterParams,
      {
        name: 'sort',
        in: 'query',
        required: false,
        description: `Sort field; prefix with "-" for descending (e.g. sort=-created_at). One of: ${Object.keys(def.sortable).join(', ')}.`,
        schema: { type: 'string', enum: Object.keys(def.sortable).flatMap((f) => [f, `-${f}`]) },
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description:
          'Presence of this key opts into cursor (keyset) pagination, stable under concurrent inserts/deletes: ' +
          'empty on the first request, then the previous response\'s next_cursor on each following one. Limit caps ' +
          'at 100 in this mode. Omit the key entirely for legacy offset mode (limit/offset, max 200).',
        schema: { type: 'string' },
      },
      { name: 'limit', in: 'query', required: false, description: 'Page size. 1–200 in offset mode, 1–100 in cursor mode. Default 25.', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      { name: 'offset', in: 'query', required: false, description: 'Rows to skip. Offset mode only (ignored, and returned as null, when ?cursor is used). Default 0.', schema: { type: 'integer', minimum: 0 } },
    ];
    const tag = name.charAt(0).toUpperCase() + name.slice(1);
    const listResponseSchema = {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: ['integer', 'null'], description: 'null in cursor mode.' },
        has_more: { type: 'boolean' },
        next_cursor: { type: ['string', 'null'], description: 'Pass as ?cursor= to fetch the next page; null on the last page. Always null in offset mode.' },
      },
    };

    paths[`/events/{event_id}/${name}`] = {
      get: {
        summary: `List ${name}`,
        description: `Filterable, sortable, paginated list (cursor or offset mode). Unknown filter names are ignored, never an error. The admin workspace runs the exact same query.`,
        tags: [tag],
        parameters: listParams,
        responses: {
          '200': { description: `${tag} rows.`, content: { 'application/json': { schema: listResponseSchema } } },
          '400': errorResponse('Invalid ?cursor value.'),
          '401': errorResponse('Missing or invalid credentials.'),
          '403': errorResponse('The credential cannot access this event.'),
        },
      },
    };

    paths[`/events/{event_id}/${name}/export`] = {
      get: {
        summary: `Export ${name} (CSV/XLSX)`,
        description: 'Same filters as the list endpoint; up to 10,000 rows. The workspace export buttons call this with the currently active filters.',
        tags: [tag],
        parameters: [
          eventIdParam,
          ...filterParams,
          { name: 'format', in: 'query', required: false, description: 'csv (default) or xlsx.', schema: { type: 'string', enum: ['csv', 'xlsx'] } },
          { name: 'sort', in: 'query', required: false, description: 'Same as the list endpoint.', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'The file, as an attachment.' },
          '401': errorResponse('Missing or invalid credentials.'),
        },
      },
    };
  }

  paths['/events/{event_id}/submissions/{id}'] = {
    get: {
      summary: 'Get one submission',
      description: 'Full record: parsed answers, participants, tags and the review summary — the same shape the workspace detail tab renders.',
      tags: ['Submissions'],
      parameters: [eventIdParam, idParam('submission')],
      responses: {
        '200': { description: 'The submission.', content: { 'application/json': { schema: { type: 'object' } } } },
        '404': errorResponse('No submission with this id in this event.'),
      },
    },
  };

  const submissionStatusEnum = ['draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn'];

  paths['/events/{event_id}/submissions/{id}/status'] = {
    post: {
      summary: 'Change a submission status',
      description:
        'Moves a submission between pipeline states. Decision emails are deliberately NOT sent from here — batch notification stays in the app (Evaluation → send decisions), so an API status change never emails a speaker by surprise.',
      tags: ['Submissions'],
      parameters: [eventIdParam, idParam('submission'), idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: submissionStatusEnum } },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } } } } },
        '404': errorResponse('No submission with this id in this event.'),
        '422': errorResponse('Invalid status value, or (with Idempotency-Key) this key was already used with a different body.'),
      },
    },
  };

  paths['/events/{event_id}/contacts/{id}'] = {
    get: {
      summary: 'Get one contact',
      tags: ['Contacts'],
      parameters: [eventIdParam, idParam('contact')],
      responses: {
        '200': { description: 'The contact.', content: { 'application/json': { schema: { type: 'object' } } } },
        '404': errorResponse('No contact with this id in this event.'),
      },
    },
  };

  // -------------------------------------------------------------------------
  // Core CRUD (work item 2). Manual writes on top of the registry-driven
  // list/detail/export endpoints above.
  // -------------------------------------------------------------------------

  const contactBody = {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email', description: 'Required on create; lowercased. UNIQUE(event_id, email) — a conflict is 409 email_exists.' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      company: { type: 'string' },
      job_title: { type: 'string' },
      mobile_phone: { type: 'string' },
      biography: { type: 'string' },
      pronouns: { type: 'string' },
    },
  };

  paths['/events/{event_id}/contacts'] = {
    post: {
      summary: 'Create a contact',
      tags: ['Contacts'],
      parameters: [eventIdParam, idempotencyKeyHeader],
      requestBody: { required: true, content: { 'application/json': { schema: contactBody } } },
      responses: {
        '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': errorResponse('email is required or not a valid address.'),
        '409': errorResponse('A contact with this email already exists in this event (email_exists).'),
        ...idempotencyResponses,
      },
    },
  };

  (paths['/events/{event_id}/contacts/{id}'] as Record<string, unknown>).put = {
    summary: 'Update a contact',
    tags: ['Contacts'],
    parameters: [eventIdParam, idParam('contact'), idempotencyKeyHeader],
    requestBody: { required: true, content: { 'application/json': { schema: contactBody } } },
    responses: {
      '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object' } } } },
      '400': errorResponse('email cannot be cleared / invalid shape.'),
      '404': errorResponse('No contact with this id in this event.'),
      '409': errorResponse('A contact with this email already exists in this event (email_exists).'),
      ...idempotencyResponses,
    },
  };

  (paths['/events/{event_id}/contacts/{id}'] as Record<string, unknown>).delete = {
    summary: 'Delete a contact',
    description: 'Nulls the headshot reference then deletes in one batch (mutual FK with file_assets); a remaining constraint violation is 409, not a 500.',
    tags: ['Contacts'],
    parameters: [eventIdParam, idParam('contact'), idempotencyKeyHeader],
    responses: {
      '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
      '404': errorResponse('No contact with this id in this event.'),
      '409': errorResponse('This contact cannot be deleted while other records reference it.'),
      ...idempotencyResponses,
    },
  };

  const submissionWriteBody = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Required on create.' },
      description: { type: 'string' },
      format: { type: 'string' },
      level: { type: 'string' },
      language: { type: 'string' },
      track_id: { type: 'string', description: 'Must belong to this event, or 400 validation.' },
      status: { type: 'string', enum: submissionStatusEnum, description: 'Update only; ignored on create (always starts pending).' },
    },
  };

  paths['/events/{event_id}/submissions'] = {
    post: {
      summary: 'Create a submission (manual)',
      description: 'Admin-authored submission, not through a public form. status starts "pending"; source is "manual"; code is allocated as SESS-<n>, same allocator as the rest of the app.',
      tags: ['Submissions'],
      parameters: [eventIdParam, idempotencyKeyHeader],
      requestBody: { required: true, content: { 'application/json': { schema: submissionWriteBody } } },
      responses: {
        '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': errorResponse('title is required, or track_id does not belong to this event.'),
        ...idempotencyResponses,
      },
    },
  };

  (paths['/events/{event_id}/submissions/{id}'] as Record<string, unknown>).put = {
    summary: 'Update a submission',
    tags: ['Submissions'],
    parameters: [eventIdParam, idParam('submission'), idempotencyKeyHeader],
    requestBody: { required: true, content: { 'application/json': { schema: submissionWriteBody } } },
    responses: {
      '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object' } } } },
      '400': errorResponse('Invalid field value, or track_id does not belong to this event.'),
      '404': errorResponse('No submission with this id in this event.'),
      ...idempotencyResponses,
    },
  };

  (paths['/events/{event_id}/submissions/{id}'] as Record<string, unknown>).delete = {
    summary: 'Delete a submission',
    description: 'Cascades: answers, participants, tags, review data, task assignments.',
    tags: ['Submissions'],
    parameters: [eventIdParam, idParam('submission'), idempotencyKeyHeader],
    responses: {
      '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
      '404': errorResponse('No submission with this id in this event.'),
      ...idempotencyResponses,
    },
  };

  const taskBody = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Required on create.' },
      description: { type: 'string' },
      target: { type: 'string', enum: ['contact', 'group', 'submission'] },
      assignment_mode: { type: 'string', enum: ['manual', 'automatic'] },
      trigger: { type: 'string', enum: ['on_accept', 'on_schedule', 'none'] },
      action_type: { type: 'string', enum: ['file_upload', 'portal_form', 'acknowledge', 'external_link'] },
      portal_form_id: { type: 'string', description: 'Must belong to this event.' },
      file_request_id: { type: 'string', description: 'Must belong to this event.' },
      due_at: { type: 'string', format: 'date-time' },
      reminder_offsets_days: { type: 'array', items: { type: 'integer' } },
      required: { type: 'boolean' },
    },
  };

  paths['/events/{event_id}/tasks'] = {
    post: {
      summary: 'Create a task',
      tags: ['Tasks'],
      parameters: [eventIdParam, idempotencyKeyHeader],
      requestBody: { required: true, content: { 'application/json': { schema: taskBody } } },
      responses: {
        '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': errorResponse('Invalid or missing field.'),
        ...idempotencyResponses,
      },
    },
  };

  paths['/events/{event_id}/tasks/{id}'] = {
    put: {
      summary: 'Update a task',
      tags: ['Tasks'],
      parameters: [eventIdParam, idParam('task'), idempotencyKeyHeader],
      requestBody: { required: true, content: { 'application/json': { schema: taskBody } } },
      responses: {
        '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': errorResponse('Invalid field value.'),
        '404': errorResponse('No task with this id in this event.'),
        ...idempotencyResponses,
      },
    },
    delete: {
      summary: 'Delete a task',
      description: 'Assignments cascade via task_id.',
      tags: ['Tasks'],
      parameters: [eventIdParam, idParam('task'), idempotencyKeyHeader],
      responses: {
        '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
        '404': errorResponse('No task with this id in this event.'),
        ...idempotencyResponses,
      },
    },
  };

  // Forms: read-only in v1 preview. Creation/editing stays admin-UI only.
  paths['/events/{event_id}/forms'] = {
    get: {
      summary: 'List forms',
      tags: ['Forms'],
      parameters: [eventIdParam],
      responses: {
        '200': { description: 'Forms, with question/submission counts.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
      },
    },
  };

  paths['/events/{event_id}/forms/{id}'] = {
    get: {
      summary: 'Get one form',
      description: 'The form plus its questions, in position order.',
      tags: ['Forms'],
      parameters: [eventIdParam, idParam('form')],
      responses: {
        '200': { description: 'The form.', content: { 'application/json': { schema: { type: 'object' } } } },
        '404': errorResponse('No form with this id in this event.'),
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'KMS API (v1 preview)',
      version: '1.0.0-preview',
      description: [
        'Conference & CFP management. Bearer tokens are organisation-scoped; every request names its event in the path.',
        '',
        '**Status: v1 preview.** This document describes exactly the surface that exists — core CRUD for ' +
          'submissions, contacts, tasks, and read-only forms, plus the events/export endpoints. Webhooks, sparse ' +
          'fieldsets, multi-field sort, and rate limiting are not implemented; see docs/10-api.md §6 for the full list.',
        '',
        '**Quickstart — list pending submissions:**',
        '```',
        `curl -H "Authorization: Bearer kms_…" \\`,
        `  "${origin}/api/v1/events/EVENT_ID/submissions?status=pending&sort=-created_at"`,
        '```',
        'Create a token under **Settings → API tokens** in the admin app, then `GET /events` to find your event id.',
        '',
        'Conventions: JSON in and out; errors are `{ "error": { "code", "message", "details"? } }`; unknown filter ' +
          'names are ignored, never an error; list responses are `{ data, total, limit, offset, has_more, next_cursor }`. ' +
          'Pass `?cursor=` for stable keyset pagination (recommended); omit it for legacy offset (`limit`/`offset`) mode. ' +
          'POSTs accept an `Idempotency-Key` header for safe retries.',
      ].join('\n'),
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token from Settings → API tokens (kms_…). First-party requests may use the admin session cookie instead.',
        },
      },
    },
    paths,
  };
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

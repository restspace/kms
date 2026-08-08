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
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
  },
});

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
      { name: 'limit', in: 'query', required: false, description: 'Page size, 1–200. Default 25.', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      { name: 'offset', in: 'query', required: false, description: 'Rows to skip. Default 0.', schema: { type: 'integer', minimum: 0 } },
    ];
    const tag = name.charAt(0).toUpperCase() + name.slice(1);

    paths[`/events/{event_id}/${name}`] = {
      get: {
        summary: `List ${name}`,
        description: `Filterable, sortable, paginated list. Unknown filter names are ignored, never an error. The admin workspace runs the exact same query.`,
        tags: [tag],
        parameters: listParams,
        responses: {
          '200': {
            description: `${tag} rows.`,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'object' } },
                    total: { type: 'integer' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                    has_more: { type: 'boolean' },
                  },
                },
              },
            },
          },
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

  paths['/events/{event_id}/submissions/{id}/status'] = {
    post: {
      summary: 'Change a submission status',
      description:
        'Moves a submission between pipeline states. Decision emails are deliberately NOT sent from here — batch notification stays in the app (Evaluation → send decisions), so an API status change never emails a speaker by surprise.',
      tags: ['Submissions'],
      parameters: [eventIdParam, idParam('submission')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['status'],
              properties: {
                status: {
                  type: 'string',
                  enum: ['draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn'],
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } } } } },
        '404': errorResponse('No submission with this id in this event.'),
        '422': errorResponse('Invalid status value.'),
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

  return {
    openapi: '3.1.0',
    info: {
      title: 'KMS API',
      version: '1.0.0',
      description: [
        'Conference & CFP management. Bearer tokens are organisation-scoped; every request names its event in the path.',
        '',
        '**Quickstart — list pending submissions:**',
        '```',
        `curl -H "Authorization: Bearer kms_…" \\`,
        `  "${origin}/api/v1/events/EVENT_ID/submissions?status=pending&sort=-created_at"`,
        '```',
        'Create a token under **Settings → API tokens** in the admin app, then `GET /events` to find your event id.',
        '',
        'Conventions: JSON in and out; errors are `{ "error": { "code", "message" } }`; unknown filter names are ignored, never an error; list responses are `{ data, total, limit, offset, has_more }`.',
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

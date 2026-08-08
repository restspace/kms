# 10 — Public API & Webhooks

The brief awards **bonus points for an API**, pointing at the
[Sessionboard API docs](https://sessionboard.mintlify.app/introduction) as the reference shape.
Building the product API-first also makes the admin SPA and the public pages consumers of the
same surface, which is cheaper than maintaining two paths.

---

## 1. Conventions

| Aspect | Convention |
|---|---|
| Base URL | `https://<host>/api/v1` |
| Format | JSON; `Content-Type: application/json`; UTF-8 |
| Auth | `Authorization: Bearer <api_token>` (server-to-server) or the session cookie (first-party) |
| Scoping | Tokens are scoped to an organisation; most resources are nested under `/events/:event_id` |
| IDs | Opaque strings (prefixed UUIDs: `sub_…`, `ses_…`, `con_…`, `frm_…`, `tsk_…`) |
| Timestamps | ISO 8601 UTC (`2026-10-12T16:00:00Z`); responses also carry `*_local` in the event timezone where useful |
| Pagination | `?limit=25&cursor=<opaque>` → `{ data: [...], next_cursor, has_more }` |
| Filtering | `?status=pending&track_id=…&updated_since=…` |
| Sorting | `?sort=-created_at,title` |
| Sparse fields | `?fields=id,title,status` |
| Errors | `{ "error": { "code": "validation_error", "message": "...", "details": [{"field":"title","issue":"required"}] } }` |
| Rate limit | 600 req/min per token; `X-RateLimit-*` headers; 429 with `Retry-After` |
| Idempotency | `Idempotency-Key` header honoured on all POSTs |
| Versioning | Path version `v1`; additive changes only within a version |

---

## 2. Resources

### Events
```
GET    /events
POST   /events
GET    /events/:event_id
PATCH  /events/:event_id
DELETE /events/:event_id
```

### Forms
```
GET    /events/:event_id/forms
POST   /events/:event_id/forms
GET    /events/:event_id/forms/:form_id            # includes questions, conditional logic, routing
PATCH  /events/:event_id/forms/:form_id
POST   /events/:event_id/forms/:form_id/duplicate
GET    /events/:event_id/forms/:form_id/schema     # public: renderable definition, cacheable
```

### Submissions
```
GET    /events/:event_id/submissions
POST   /events/:event_id/submissions                # admin create (manual)
GET    /events/:event_id/submissions/:id
PATCH  /events/:event_id/submissions/:id
DELETE /events/:event_id/submissions/:id
POST   /events/:event_id/submissions/:id/status     # { status, notify: bool }
POST   /events/:event_id/submissions/bulk/status    # { ids[], status, notify }
GET    /events/:event_id/submissions/export?format=csv|xlsx
POST   /events/:event_id/submissions/import         # multipart, dry_run supported
GET    /events/:event_id/submissions/:id/files
```

Query params: `status`, `form_id`, `track_id`, `tag_id`, `format`, `q`, `has_rating`,
`plan_id`, `scheduled=true|false`, `updated_since`.

**Submission object**
```json
{
  "id": "sub_01H…",
  "code": "SESS-4",
  "kind": "session",
  "title": "Shipping agents that don't melt",
  "description": "<p>…</p>",
  "status": "accepted",
  "format": "Featured Keynote",
  "level": "Intermediate",
  "language": "en",
  "track": { "id": "trk_…", "name": "Agents" },
  "tags": [{ "id": "tag_…", "name": "AI" }],
  "capacity": 300,
  "ceu_credits": null,
  "client_session_id": null,
  "starts_at": "2026-10-12T16:00:00Z",
  "ends_at": "2026-10-12T16:30:00Z",
  "room": { "id": "room_…", "name": "Main Stage" },
  "participants": [
    { "contact_id": "con_…", "role": "speaker", "is_primary_contact": true,
      "first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com" }
  ],
  "answers": { "q_track": "Agents", "q_format": "Featured Keynote" },
  "ratings": { "plan_round_1": 4.33 },
  "notified_at": "2026-08-20T18:04:00Z",
  "source": "form",
  "form_id": "frm_…",
  "created_at": "2026-08-07T23:51:05Z",
  "updated_at": "2026-08-20T18:04:00Z"
}
```

### Public submission endpoint
```
POST /public/events/:slug/forms/:form_id/submissions
```
Unauthenticated but rate-limited and validated against the stored form definition (conditional
logic re-evaluated server-side, routing rules applied, limits enforced). Returns the submission
plus a portal magic-link URL.

### Contacts / speakers
```
GET    /events/:event_id/contacts
POST   /events/:event_id/contacts
GET    /events/:event_id/contacts/:id
PATCH  /events/:event_id/contacts/:id
GET    /events/:event_id/speakers            # contacts on ≥1 accepted submission
```

### Sessions & agenda
```
GET    /events/:event_id/sessions?from=&to=&room_id=&track_id=
PATCH  /events/:event_id/sessions/:id/schedule    # { starts_at, ends_at, room_id }
DELETE /events/:event_id/sessions/:id/schedule    # unschedule
GET    /events/:event_id/agenda/conflicts
POST   /events/:event_id/agenda/publish
GET    /events/:event_id/sessions/:id/calendar.ics
GET    /public/events/:slug/agenda                # published sessions only
```

### Tasks
```
GET    /events/:event_id/tasks
POST   /events/:event_id/tasks
GET    /events/:event_id/tasks/:id
POST   /events/:event_id/tasks/:id/assign         # { contact_ids[], submission_ids[] }
GET    /events/:event_id/task-assignments?status=&contact_id=&overdue=true
POST   /events/:event_id/task-assignments/:id/complete
POST   /events/:event_id/task-assignments/:id/remind
```

### Evaluation
```
GET    /events/:event_id/evaluation-plans
POST   /events/:event_id/evaluation-plans
POST   /events/:event_id/evaluation-plans/:id/assignments   # { submission_ids[], reviewer_ids[], strategy }
GET    /events/:event_id/evaluation-plans/:id/reviews
POST   /events/:event_id/reviews                            # { assignment_id, scores, comment }
GET    /events/:event_id/evaluation-plans/:id/results
```

### Library
```
GET/POST/PATCH/DELETE  /events/:event_id/tracks
GET/POST/PATCH/DELETE  /events/:event_id/rooms
GET/POST/PATCH/DELETE  /events/:event_id/tags
GET/POST/PATCH/DELETE  /events/:event_id/fields
```

### Communications
```
GET    /events/:event_id/email-templates
PATCH  /events/:event_id/email-templates/:key
POST   /events/:event_id/email-templates/:key/preview     # { context_ids } -> rendered html/text
POST   /events/:event_id/messages/send                    # { template_key, contact_ids[], context }
GET    /events/:event_id/messages                         # message log
```

### Dashboard
```
GET /events/:event_id/dashboard/:key/summary   # today | speaker_tracking | submissions_pipeline | review_progress
```
Returns pre-aggregated widget payloads with an `ETag` and `updated_at`.

### Files
```
POST /events/:event_id/uploads         # -> { upload_url, asset_id } presigned
GET  /events/:event_id/assets/:id      # signed download redirect
GET  /events/:event_id/submissions/export/files.zip
```

---

## 3. Webhooks

Configure endpoints per event with a shared secret.

| Event | Payload |
|---|---|
| `submission.created` | submission object |
| `submission.updated` | submission + changed fields |
| `submission.status_changed` | submission, `from`, `to` |
| `session.scheduled` / `session.rescheduled` / `session.unscheduled` | session object |
| `task.assigned` / `task.completed` | assignment + contact |
| `speaker.profile_updated` | contact object |
| `review.submitted` | review object |

Delivery: `POST` with headers `X-Signature: sha256=<hmac(body, secret)>`, `X-Event-Id`,
`X-Event-Type`. Retries at 1 m, 5 m, 30 m, 2 h, 12 h. A delivery log is visible in the admin UI.

---

## 4. Public read endpoints (no auth)

```
GET /public/events/:slug
GET /public/events/:slug/agenda
GET /public/events/:slug/speakers
GET /public/events/:slug/forms/:form_id/schema
GET /embed/:token            # HTML
GET /embed/:token.js         # loader script
```
Cached at the edge (60 s for the agenda, 5 min for embeds), CORS-enabled, and limited to
published/accepted records with PII stripped (no emails or phone numbers).

---

## 5. Documentation

Publish an OpenAPI 3.1 document at `/api/v1/openapi.json` and render it (Scalar/Redoc) at
`/docs`. Include a copy-pasteable cURL example per endpoint and a "submit a proposal via API"
quickstart — that is the example a judge is most likely to try.

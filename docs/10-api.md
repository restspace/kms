# 10 — Public API

The brief awards **bonus points for an API**, pointing at the
[Sessionboard API docs](https://sessionboard.mintlify.app/introduction) as the reference shape.
Building the product API-first also makes the admin SPA a consumer of the same surface (the
generic list endpoints and the OpenAPI document are both generated from the `RESOURCES` registry
the admin workspace queries), which is cheaper than maintaining two paths.

**Status: v1 preview.** This document describes exactly the surface that exists today — nothing
more. An earlier draft of this page described a much larger contract (webhooks, sparse
fieldsets, full library/evaluation/communications CRUD, embeds…) before any of it was built; §6
lists what was cut and why. Treat everything below as implemented and tested; treat §6 as a
roadmap, not a promise.

---

## 1. Conventions

| Aspect | Convention |
|---|---|
| Base URL | `https://<host>/api/v1` |
| Format | JSON in and out; `Content-Type: application/json`; UTF-8 |
| Auth | `Authorization: Bearer <api_token>` (server-to-server) or the admin session cookie (first-party, owner/admin only) |
| Scoping | Tokens are organisation-scoped; almost everything is nested under `/events/:event_id` — the token's organisation must own the event, checked on every request |
| IDs | Opaque strings (`crypto.randomUUID()`), not sequential |
| Timestamps | ISO 8601 UTC |
| Pagination | Cursor mode (`?cursor=`) is recommended and stable under concurrent writes; offset mode (`?limit=&offset=`) is legacy back-compat — see §1a |
| Filtering | Resource-specific query params, e.g. `?status=pending&track_id=…` — unknown filter names are silently ignored, never an error |
| Sorting | `?sort=field` or `?sort=-field` for descending — one field at a time |
| Idempotency | `Idempotency-Key` header honoured on every POST — see §1b |
| Errors | `{ "error": { "code": "...", "message": "...", "details": [{"field","message"}]? } }` |
| Versioning | Path version `v1`; this is a preview — the shape may still change before a `v2` is cut |
| Rate limiting | **Not implemented.** No `X-RateLimit-*` headers, no 429s. Don't build a client that assumes them. |

### 1a. Pagination

**Cursor mode** (preferred): include the `cursor` query parameter to opt in — empty
(`?cursor=`) on the first request, then `?cursor=<value from the previous response's
next_cursor>` on each following one. (Omitting the `cursor` key entirely uses offset mode
instead — see below.) Page size is `?limit=` (1–100, default 25). The response is:

```json
{ "data": [...], "total": 118, "limit": 25, "offset": null, "has_more": true, "next_cursor": "eyJ2Ijoi..." }
```

`next_cursor` is `null` on the last page. Cursor mode orders by the requested `?sort=` field
(default: `id`) plus the row id as a tiebreaker, so pages stay stable even if rows are inserted
or deleted between requests — no skipped or duplicated rows, which offset pagination cannot
guarantee. An invalid or expired-shape cursor is a `400 { "error": { "code": "invalid_cursor" } }`.

**Offset mode** (legacy, kept for back-compat): omit `?cursor` entirely and use `?limit=&offset=`
(limit 1–200, default 25/0). Same response shape, with `offset` populated and `next_cursor`
always `null`. New integrations should use cursor mode.

### 1b. Idempotency

Any POST in this API may carry an `Idempotency-Key` header (any client-chosen string, unique per
logical operation). The key is scoped to the calling credential (a token, or the admin session):

- **First use:** the request executes normally; the response (status + body) is cached for 24h,
  keyed on `sha256(credential + key)`. Only 2xx/4xx outcomes are cached — a 5xx is never stored,
  so a genuinely failed request can be retried with the same key.
- **Replay** (same credential + key, same body): returns the cached response verbatim, with an
  added `Idempotency-Replayed: true` header. The operation does not execute again — no duplicate
  row, no duplicate side effect.
- **Key reuse with a different body:** `422 { "error": { "code": "idempotency_mismatch" } }`. This
  is a client bug (the key is meant to identify one specific request) surfaced immediately rather
  than silently doing the wrong thing.

Idempotency-Key is optional. Without it, retries are plain retries (may create duplicates on a
POST that creates a row) — the same behaviour every HTTP API has by default.

---

## 2. Events

```
GET /events              — every event this credential can reach
GET /events/:event_id    — one event
```

Tokens see every event in their organisation; the admin session sees only the event it's
currently switched to. Event creation/editing is admin-UI only in this preview (`POST /app/api/events`,
not part of the public surface yet).

**Event object**
```json
{
  "id": "evt_…", "org_id": "org_…", "name": "KMS Conf 2026", "slug": "kmsconf-2026",
  "type": "conference", "location": "Austin, TX", "timezone": "America/Chicago",
  "starts_at": "2026-10-12T00:00:00Z", "ends_at": "2026-10-14T00:00:00Z",
  "created_at": "…", "updated_at": "…"
}
```

---

## 3. Resources

Four resources share one generic list machinery — same filters, same sort whitelist, same
pagination, same CSV/XLSX export — as the admin workspace's own query tool:

```
GET /events/:event_id/contacts
GET /events/:event_id/submissions
GET /events/:event_id/tasks
GET /events/:event_id/messages
GET /events/:event_id/:resource/export?format=csv|xlsx   # same filters, up to 10,000 rows
```

Each resource's filter vocabulary and sortable fields are self-described at
`GET /api/v1/openapi.json` — that document is generated from the same registry the query executor
runs, so it cannot describe a filter that doesn't exist.

### 3.1 Contacts

```
GET    /events/:event_id/contacts               ?q=&submission_id=&contact_id=&missing_assets=true
GET    /events/:event_id/contacts/:id
POST   /events/:event_id/contacts
PUT    /events/:event_id/contacts/:id
DELETE /events/:event_id/contacts/:id
```

`POST`/`PUT` body (all optional except `email` on create):
```json
{ "email": "ada@example.com", "first_name": "Ada", "last_name": "Lovelace",
  "company": "Analytical Engines Inc", "job_title": "Speaker", "mobile_phone": "+1…",
  "biography": "…", "pronouns": "she/her" }
```

- `email` is required on create, lowercased on write, shape-checked
  (`local@domain.tld` — deliberately not RFC-complete). `event_id + email` is unique; a conflict
  is `409 { "error": { "code": "email_exists" } }`.
- `PUT` accepts a partial body; only the keys present are changed. `email` cannot be cleared
  (sending `email: null` on an update is a `400 validation` error).
- `DELETE` removes the contact. If the contact is a headshot upload's `uploaded_by_contact_id` or
  otherwise still referenced by a row without a cascading foreign key, the delete is rejected with
  `409 { "error": { "code": "constraint" } }` rather than a 500.

### 3.2 Submissions

```
GET    /events/:event_id/submissions             ?q=&status=&track_id=&tag_id=&submitter_contact_id=&participant_contact_id=&contact_id=
GET    /events/:event_id/submissions/:id          # full record: parsed answers, participants, tags, review summary
POST   /events/:event_id/submissions
PUT    /events/:event_id/submissions/:id
DELETE /events/:event_id/submissions/:id
POST   /events/:event_id/submissions/:id/status   # { "status": "..." } — pipeline move only, no email
```

`POST` (manual/admin-authored create — not through a public form):
```json
{ "title": "Shipping agents that don't melt", "description": "<p>…</p>",
  "format": "Talk", "level": "Intermediate", "language": "en", "track_id": "trk_…" }
```
- `title` is required. `track_id`, if given, must belong to this event — a cross-event or unknown
  id is `400 { "error": { "code": "validation", "details": [{ "field": "track_id", ... }] } }`.
- `status` always starts `"pending"`; `source` is always `"manual"` — both are server-assigned,
  not client input, on create.
- `code` is allocated as `SESS-<n>`, the next integer after the highest existing code for the
  event — the same allocator the rest of the app uses, so manual and form-submitted codes never
  collide.

`PUT` accepts a partial body from `{ title, description, format, level, language, track_id, status }`
— `status` here *is* writable (unlike create) and goes through the same enum as the dedicated
`/status` endpoint (`draft|pending|accept_queue|accepted|decline_queue|declined|withdrawn`).

`DELETE` cascades: answers, participants, tags, review assignments/reviews, and task assignments
tied to the submission are removed with it.

### 3.3 Tasks

```
GET    /events/:event_id/tasks         ?q=&status=&task_id=&contact_id=&submission_id=&overdue=true
POST   /events/:event_id/tasks
PUT    /events/:event_id/tasks/:id
DELETE /events/:event_id/tasks/:id
```

Note: the list endpoint returns **task assignments** joined to their task (one row per
contact/submission the task is assigned to) — this matches the admin Tasks tab. `POST`/`PUT`/
`DELETE` operate on the **task definition** itself:

```json
{ "title": "Submit final slides", "description": "…", "target": "submission",
  "assignment_mode": "automatic", "trigger": "on_accept", "action_type": "file_upload",
  "file_request_id": "freq_…", "due_at": "2026-10-01T00:00:00Z",
  "reminder_offsets_days": [7, 1], "required": true }
```

- `title` is required on create.
- `target` ∈ `contact|group|submission`; `assignment_mode` ∈ `manual|automatic`;
  `trigger` ∈ `on_accept|on_schedule|none`; `action_type` ∈ `file_upload|portal_form|acknowledge|external_link`.
- `portal_form_id` / `file_request_id`, if given, must belong to this event.
- `reminder_offsets_days` is an array of integers (days before `due_at`) or `null`.
- Assigning contacts/submissions to a task (`task_assignments`) is not part of this preview's
  public surface — it stays admin-UI only for now.
- `DELETE` cascades to the task's assignments.

### 3.4 Forms (read-only)

```
GET /events/:event_id/forms          # list, with question/submission counts
GET /events/:event_id/forms/:id      # form + its questions, in position order
```

Form creation and editing (`submission_forms`, `form_questions`, routing rules, conditional
logic) stays admin-UI only in this preview — see `docs/04-cfp-and-forms.md`. Read access is
useful on its own (an integration that needs to know which forms exist and what they ask), so it
shipped; the write surface did not.

### 3.5 Messages (read-only)

```
GET /events/:event_id/messages   ?q=&template_key=&status=&contact_id=
```

The send/delivery log — no detail or write endpoints in this preview.

---

## 4. Quickstart (copy-paste)

```bash
# 1. Create a token: Settings → API tokens in the admin app (or reuse an existing kms_… value).
export KMS_TOKEN="kms_…"
export KMS_HOST="https://your-deployment.example.com"

# 2. List events this token can reach, grab the first event id.
EVENT_ID=$(curl -s -H "Authorization: Bearer $KMS_TOKEN" \
  "$KMS_HOST/api/v1/events" | jq -r '.data[0].id')

# 3. Create a manual submission.
SUB_ID=$(curl -s -X POST \
  -H "Authorization: Bearer $KMS_TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-submission-1" \
  -d '{"title":"Shipping agents that don'"'"'t melt","format":"Talk"}' \
  "$KMS_HOST/api/v1/events/$EVENT_ID/submissions" | jq -r '.id')

# 4. Move it to accept_queue.
curl -s -X POST \
  -H "Authorization: Bearer $KMS_TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-submission-1-accept" \
  -d '{"status":"accept_queue"}' \
  "$KMS_HOST/api/v1/events/$EVENT_ID/submissions/$SUB_ID/status"

# 5. Export the pipeline as CSV.
curl -s -H "Authorization: Bearer $KMS_TOKEN" \
  "$KMS_HOST/api/v1/events/$EVENT_ID/submissions/export?format=csv" -o submissions.csv
```

Re-running step 3 with the same `Idempotency-Key` returns the same submission (no duplicate);
re-running it with a different title under that key is a `422 idempotency_mismatch`.

---

## 5. Documentation

An OpenAPI 3.1 document is published at `/api/v1/openapi.json`, generated at request time from
the same `RESOURCES` registry the query executor runs — it cannot describe an endpoint that
doesn't exist. A minimal rendered view (Scalar, CDN-loaded, with a no-JS fallback linking the raw
JSON) is served at `/docs`.

---

## 6. Explicitly out of scope for v1 preview

The following were in an earlier draft of this document and are **not implemented**. They are
listed here so the spec stops overpromising (see `tests/sweep-handoff.md` item 13) — not as a
denial that they'd be useful.

- **Webhooks / delivery logs.** No outbound event notifications (`submission.created`,
  `session.scheduled`, etc.), no signing secret, no retry schedule, no delivery UI.
- **Sparse fieldsets** (`?fields=id,title,status`). Every response returns its full shape.
- **Multi-field sort** (`?sort=-created_at,title`). One `?sort=` field at a time.
- **Rate limiting.** No request budget, no `X-RateLimit-*` headers, no `429`.
- **Public JSON API** (`/public/events/:slug`, `/public/events/:slug/speakers`, published-agenda
  JSON, etc.) and **embeds** (`/embed/:token`). The one public read endpoint that exists —
  `GET /e/:slug/agenda.json` — lives outside `/api/v1` and is documented in
  `docs/07-agenda-and-scheduling.md`, not here.
- **Public submission endpoint** (`POST /public/events/:slug/forms/:form_id/submissions`). Public
  form submission is a server-rendered flow (`packages/ui/src/SubmitPage.tsx` → `submit.tsx`),
  not a documented JSON API — building a second, parallel JSON path for it is deferred.
- **Sessions/agenda, evaluation, communications, library (tracks/rooms/tags/fields), files, and
  dashboard endpoints.** All exist as admin-UI features (see docs 06–09) but have no `/api/v1`
  surface yet.
- **Forms CRUD.** Read-only in this preview (§3.4); creation/editing is admin-UI only.
- **Task assignment endpoints** (assigning a task to contacts/submissions, marking complete,
  sending a reminder). The task *definition* has full CRUD (§3.3); assignment operations do not.
- **Event create/update/delete** via `/api/v1`. Admin-UI only (`POST /app/api/events`).

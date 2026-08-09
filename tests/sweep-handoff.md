# Repository Sweep — Remaining Work Handoff

Date: 2026-08-09  
Scope reviewed: correctness, security, maintainability, usability/accessibility, performance, CI/deployment, and spec alignment.

This document contains work remaining after the repository-wide sweep. The fixes already present in the working tree include CFP rich-text sanitisation/CSP, escaped email variables, participant profile protection, event-scoped routing targets, privileged-role revalidation, leased outbox claims, file signature checks, ICS timezone/folding fixes, form-builder save guards, CI asset builds, the Vite upgrade, and initial Vitest coverage.

## Priority summary

| Priority | Area | Main risk |
|---|---|---|
| P0 | Submission transaction and code/quota allocation | Partial or duplicate submissions under failures/concurrency |
| P0 | Magic-link consumption and confirmation links | Tokens are not strongly single-use; confirmation email does not authenticate |
| P1 | File authorisation and request-specific policy | Same-event users can access assets they do not own |
| P1 | Review/task uniqueness and concurrency | Duplicate reviews/tasks can corrupt aggregates |
| P1 | UI mutation ordering and failure recovery | UI can show changes that were never saved or overwrite newer changes |
| P1 | Participant-form contract | Configured participant fields are not fully rendered, validated, or stored |
| P1 | Accessibility | Core workflows are not fully keyboard or focus operable |
| P1 | API/spec completion | Large portions of the documented API and notifications are absent |
| P2 | Dashboard, agenda, grids, and bulk email performance | Work scales with open tabs/drag events/offset pages rather than writes |
| P2 | Architecture and oversized modules | Tenant scoping and change safety depend on route-level discipline |

## P0 — Correctness and security

### 1. Make public submission persistence atomic

Evidence:

- `apps/api/src/routes/submit.tsx` writes the submission, answers, tags, contacts, participants, and email job through separate operations.
- `nextCode()` uses `MAX(code) + 1` separately from insertion.
- Submission-limit checks are read-before-write.
- `apps/api/src/routes/agenda.ts` uses a similar code-allocation pattern for manual sessions.

Failure modes:

- A participant/tag/answer failure can leave a pending submission with incomplete related data.
- Two concurrent requests can choose the same `(event_id, code)` and one returns a server error.
- Concurrent requests can exceed the per-user form limit.

Recommended implementation:

1. Validate and normalise the complete request before the first write.
2. Introduce an event-scoped atomic sequence/counter for human submission codes.
3. Enforce quotas inside the same transaction as creation.
4. Commit the submission, answers, tags, participant links, and durable outbox record as one unit.
5. Add concurrent integration tests for identical double-submit, quota-boundary submit, and code allocation.

Acceptance criteria:

- No failed request leaves a newly pending submission with missing answers or participants.
- Parallel creates produce unique sequential codes.
- A limit of `N` cannot result in `N+1` records, including drafts.
- Retrying an identical request returns the same logical result without duplicate email.

### 2. Make magic links atomically single-use

Evidence:

- `apps/api/src/routes/auth.ts` consumes a token with separate KV `get` and `delete` operations.
- KV consistency and simultaneous callbacks can allow more than one request to read the same token.

Recommended implementation:

1. Store magic-token hashes in D1 with `expires_at`, `consumed_at`, contact, event, purpose, and redirect.
2. Consume using one conditional update such as `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now RETURNING ...`.
3. Keep only hashes at rest and periodically delete expired rows.
4. Test simultaneous callbacks; exactly one must succeed.

Acceptance criteria:

- The first valid callback succeeds and every replay returns the expired/used response.
- Concurrent callbacks cannot mint two sessions.
- Tokens remain limited to 15 minutes and their intended event/purpose.

### 3. Put an authenticating link in submission confirmations

Evidence:

- `apps/api/src/routes/submit.tsx` supplies a plain `portal_url` to the confirmation template.
- `packages/email/src/render.ts` links to the portal, which asks the user to authenticate again in a fresh browser.
- The acceptance flow requires the user to enter the portal from the confirmation email.

Recommended implementation:

- Mint a purpose-bound, single-use portal magic link as part of the submission transaction, using the atomic token mechanism above.
- Do not place raw tokens in logs, database payloads, or message metadata.

Acceptance criteria:

- Opening the confirmation link in a fresh private browser authenticates the submitter and lands on the correct event portal.

## P1 — Data integrity and authorisation

### 4. Add record-level file ACLs

Current hardening checks event scope, content signatures, and safe response headers, but `/files/:id` still permits any authenticated member of the event to fetch any known asset ID.

Required policy decisions:

- A speaker can read their own headshot and files they uploaded.
- A speaker can read task/submission assets explicitly related to them.
- Admin/owner can read all event assets.
- Reviewer access should be explicit and should exclude unrelated speaker PII by default.

Recommended implementation:

1. Resolve the asset relation before loading bytes: contact headshot, file-request upload, submission asset, or event branding.
2. Authorise that relation against the current actor and role.
3. Use file-request `allowed_types` and `max_size_mb` rather than global upload defaults.
4. Add malware scanning/quarantine before an upload becomes downloadable.
5. Add access-denial tests across owner/admin/reviewer/speaker roles.

### 5. Add uniqueness constraints for review and task upserts

Evidence:

- `apps/api/src/routes/evaluation.ts` selects then inserts/updates a review.
- `reviews.assignment_id` is not unique.
- Automatic task assignment selects then inserts without a unique `(task_id, contact_id, submission_id)` constraint.

Recommended implementation:

1. Audit/deduplicate existing rows.
2. Add unique indexes for one review per assignment and one logical automatic task assignment.
3. Replace select-then-insert with `INSERT ... ON CONFLICT`.
4. Validate every reviewer ID against the event and an eligible reviewer/admin/owner role.

Acceptance criteria:

- Concurrent review saves produce one review row and one correct rating contribution.
- Re-running automatic task assignment never duplicates an assignment.

### 6. Complete server-side field validation

`packages/core/src/forms.ts` currently covers required values, maximum characters, basic email, and numeric coercion. Still required:

- Dropdown/radio option membership.
- Multiselect array shape and option membership.
- Checkbox boolean shape.
- URL protocol and syntax.
- Valid date/datetime values.
- File-field handling.
- Runtime schemas for conditional rules, routing rules, and participant-role configuration.
- Validation of manual agenda `room_id` and `track_id` inside the current event.

Malformed configuration should produce a clear 4xx validation response, never a database constraint error or cross-event relation.

### 7. Complete the configurable participant-form contract

Evidence:

- `packages/ui/src/SubmitPage.tsx` renders a fixed participant field set.
- Custom participant questions, conditional logic, and headshot fields are not represented by question ID or persisted as configured answers.
- The overall participant cap is absent.

Recommended implementation:

1. Model each participant as identity fields plus an answer map keyed by question ID.
2. Render all configured participant questions using the shared field renderer.
3. Run shared conditional visibility and validation per participant.
4. Enforce per-role min/max and the overall cap on client and server.
5. Persist custom participant answers without overwriting a confirmed contact profile.

Acceptance criteria:

- Adding a required participant question in the builder changes the public form, server validation, and saved submission detail consistently.

## P1 — UI reliability and accessibility

### 8. Make inline status edits failure-aware

Evidence:

- `apps/admin/src/App.tsx` fires `updateSubmissionStatus` without awaiting the result.
- `apps/admin/src/components/DataList.tsx` immediately replaces the local row.

Required behavior:

- Show a pending state while saving.
- On failure, roll back or refetch the row.
- Announce a visible, accessible error.
- Prevent conflicting edits to the same cell while one is pending.

### 9. Serialize agenda mutations and ignore stale responses

Evidence:

- `apps/admin/src/agenda/AgendaSection.tsx` derives mutations from captured agenda snapshots.
- Each response replaces the full agenda payload, allowing an older response to overwrite a newer move/resize/undo.

Recommended implementation:

- Queue mutations per session, or use `updated_at`/revision preconditions.
- Attach a client sequence and ignore responses older than the latest applied operation.
- Refetch authoritatively after the final queued operation or a conflict response.

### 10. Complete keyboard and modal accessibility

Known concrete issues:

- Form cards are clickable `div` elements.
- Sortable grid headers are mouse-only `div` elements.
- Context-menu items are non-focusable `div` elements without roving keyboard focus.
- Completed public-form steps use clickable `li` elements rather than buttons.
- Question reordering is pointer drag-only.
- Builder, app, and agenda dialogs do not consistently trap focus, close on Escape, or restore focus to the opener.

Recommended implementation order:

1. Replace interactive non-semantic elements with buttons/links.
2. Centralise dialogs on one tested focus-trap primitive.
3. Add keyboard move controls and an accessible move-to dialog for drag/drop workflows.
4. Add automated axe checks plus keyboard-only E2E coverage.

Target: WCAG 2.1 AA and NFR-6.

### 11. Preserve portal profile input on validation errors

Native required constraints now prevent the common blank-name case, but server validation still redirects and reconstructs the page from stored values. Return a validation response that preserves posted values and associates errors with their controls.

### 12. Add URL/history state to admin navigation

Current admin view state is local React state. Refresh returns to Dashboard, Back does not navigate between surfaces, and most views cannot be bookmarked or shared.

Encode the active view, record, agenda mode/date, builder form, and stable filters in the URL. Restore state on reload and handle `popstate`.

## P1 — Missing product/spec surfaces

### 13. Complete or explicitly narrow the REST API contract

The implementation covers a useful subset, but `docs/10-api.md` additionally specifies:

- Forms CRUD/schema.
- Manual submission CRUD/import.
- Speakers, sessions, agenda, tasks, evaluation, communications, dashboard, and files.
- Public reads and a public submission endpoint.
- Webhooks and delivery logs.
- Cursor pagination, sparse fields, multi-sort, rate-limit headers, and `Idempotency-Key` handling.
- Copy-paste cURL examples and a proposal-submission quickstart.

Choose one explicitly:

1. Implement the documented v1 contract systematically, or
2. Mark the current API as a preview/subset and change the specification/OpenAPI so it does not overpromise.

### 14. Implement stored notification configuration

Currently unused:

- `notify_admins_on_create` and `notify_admins_on_update`.
- Routing `notify_contact_ids`.
- The expected admin new/updated submission notification templates.

Validate recipients against the event, enqueue after the submission transaction commits, and use stable idempotency keys.

### 15. Finish acknowledged feature gaps

These are already documented in the secondary E2E plan and should remain separate from regressions:

- Agenda publish/unpublish.
- Forms-list search/filter counts/sort/Copy-from.
- Portal submission editing.
- Task, portal-form, and file-request authoring UI.
- Reviewer Skip, shortcuts, autosave, filters, and anonymisation controls.
- Cross-field character limits and full rich-text editing controls.
- Track, room, and tag CRUD surfaces.
- Admin-to-speaker portal impersonation entry point.

## P2 — Performance and scalability

### 16. Cache dashboard aggregates before doing the work

The dashboard currently performs roughly 17 queries, loads schedule data, computes conflicts, builds the full payload, and only then checks the ETag. A 304 saves response bytes but not D1/CPU work.

Recommended implementation:

- Cache payload plus ETag in KV by event revision.
- Invalidate/bump the revision on relevant writes.
- Recompute once per revision or short TTL, not once per polling client.
- Pause polling when the page is hidden and add jitter.
- Replace correlated per-contact task subqueries with grouped aggregates.

### 17. Make drag conflict preview incremental

`dragover` currently clones sessions and runs the full conflict engine. A synthetic 500-session same-room input generated 124,750 conflict objects in roughly 88 ms for one call, exceeding the documented interaction budget before repeated drag events are considered.

Recommended implementation:

- Add a changed-session-only preview API using room, speaker, and track indexes.
- Throttle preview to one animation frame.
- Keep the full authoritative conflict computation for server commits and the Conflicts view.

### 18. Remove repeated grid counts and offset degradation

- Pages load 50 rows.
- Each page query repeats a full `COUNT(*)`.
- OFFSET becomes progressively more expensive and less stable as records change.
- Rating sort/filter uses correlated review aggregates despite a maintained `rating_cache`.

Use keyset/cursor pagination, return/cache totals separately, and read the maintained rating cache or one grouped aggregate join.

### 19. Move bulk email operations to bounded background jobs

Agenda confirmation, decision notifications, and reminder-all flows perform serial N×DB operations within one request. At 500 sessions this can become thousands of D1 operations and provider calls.

Persist one coarse bulk job, load shared event/template/theme data once, fan out in bounded chunks, and expose progress/failure state in the UI.

### 20. Finish provider-level email idempotency

Outbox claims now use conditional leases and reclaim stuck rows, and delivery skips a message already marked sent. A crash after the provider accepts a message but before local status is recorded can still cause a retry.

Pass the outbox/message idempotency key to email providers that support it and record provider acceptance atomically where possible.

## P2 — Structure and change safety

### 21. Restore the documented persistence/domain boundary

The architecture requires scoped repositories and domain logic outside routes, but most SQL and workflows currently live in route modules. This makes tenant isolation depend on every route remembering every predicate.

Recommended extraction order:

1. Neutral resource/query registry, currently coupled to the admin route module.
2. Scoped repositories for contacts, submissions, files, tasks, evaluations, and schedules.
3. Transactional submission and decision services.
4. Email/outbox service with explicit state transitions.
5. Route handlers limited to transport parsing, authentication, and response mapping.

### 22. Split the largest UI modules

- `apps/admin/src/components/DataTabManager.tsx`: approximately 2,689 lines.
- `apps/admin/src/components/DataList.tsx`: approximately 2,019 lines.

Extract independently tested reducers/hooks for query state, selection, pagination, editing, filtering, tab persistence, DnD, export, and detail-panel behavior. Keep rendering components narrow and composable.

### 23. Expand automated testing

Vitest now covers the new sanitizer, email escaping, and ICS regressions. Still required by the architecture:

- Conditional logic, routing, field validation, participant rules, and conflict-engine unit tests.
- D1 integration tests for tenant isolation, transactions, outbox concurrency, review/task uniqueness, and quota/code allocation.
- API contract tests generated from OpenAPI.
- Browser smoke tests in CI for CFP → portal → admin decision → task → agenda → calendar.
- Load checks for 5k submissions, 10k contacts, 500 sessions, and dashboard polling.

## Validation commands

Run after each coherent batch:

```powershell
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
npm audit
```

For schema changes, additionally run migrations against a fresh local database and a copy of representative existing data before touching the shared E2E database.

## Workspace note

At handoff time, `tests/e2e-journal.md`, `tests/screenshots/s-01/`, `tests/screenshots/s-02/`, and `docs/15-winning-moves.md` contain separate user-owned work. Preserve and coordinate with those changes rather than overwriting them.

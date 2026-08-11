# Workplan 7 — Submission comment threads (reviewer discussion)

Status: **not started.** Scoping document, not a change log.

Adds a per-submission comment thread — timestamp, author, body — rendered on the
submission Detail tab for organisers and on the reviewer's scoring screen. The
thread is the discussion surface for a submission across a review round.

## 1. Decisions already taken

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Author is `author_contact_id` + `author_role` + denormalised `author_name`, **not** a bare `reviewer_id` | Admins/owners and reviewers share one table; a deleted contact does not anonymise history |
| D2 | Reviewers can read **and** write the thread | Needs a second surface in `ReviewerWorkspace.tsx`, and endpoints under `/app/api/review/` (§5.1) |
| D3 | Anchoring gate: a reviewer sees the thread once **their own** review is submitted, or once the round has closed | Uses `review_assignments.status='complete'` and `evaluation_plans.opens_at/closes_at` (0012) — no new state |
| D4 | Append-only. No edit, no delete | Matches `file_comments`; a changed opinion is a new comment |
| D5 | Internal only — never on the portal, public agenda, or REST/export surface | Nothing exposes it by default; keep it that way |
| D6 | Reviewers are shown to each other **by name** | Store the contact id regardless, so a switch to "Reviewer 1/2/3" stays display-only (§10) |

## 2. Precedent to copy

`file_comments` (`packages/db/migrations/0007_file_versions_comments.sql`) is the
same shape and solved the same problems. Reuse, near-verbatim:

- schema shape (`author_contact_id` nullable FK + stamped `author_role` + denormalised `author_name`)
- `addComment` / `loadThread` in `apps/api/src/fileVersions.ts:126-186`, including `MAX_COMMENT_CHARS = 2000` and the "empty after trim → null, surfaced as a field error not a 500" rule
- the `FileThread` component and `.file-comment` CSS (`apps/admin/src/workspace/FilePanels.tsx:80-140`, `apps/admin/src/workspace/files.css`)

Do **not** generalise `file_comments` into a polymorphic `comments(entity_type,
entity_id)` table. Its rows are anchored to an upload *version* for a reason the
submission thread does not share, and the merge buys nothing.

## 3. The `reviews.comment` question

**Checked: `Brief.md` does not mention comments at all** — no match for "comment"
in its 231 lines; the only review line is item 4, "Submission evaluation and
scoring workflows". So the per-review comment box is not a Brief-level commitment.

It *is* in the derived specs, and those are satisfied by a thread just as well:

- `docs/01-requirements.md:105` FR-REV-9 — criteria carry "an optional comment"
- `docs/01-requirements.md:106` FR-REV-10 — reviewer workspace has "score entry, **comments**"
- `docs/06-review-and-scoring.md:134` — "an overall comment box"

Current usage of the column is small and contained:

| Site | File |
| --- | --- |
| written on score save (upsert) | `apps/api/src/routes/evaluation.ts:1581,1615-1624` |
| read back into the reviewer's own form | `evaluation.ts:1433` (`r.comment AS my_comment`) |
| read into the organiser detail panel | `evaluation.ts:635` |
| the reviewer's textarea | `apps/admin/src/review/ReviewerWorkspace.tsx:133,148,223` |
| seed rows | `packages/db/seed/seed.sql:494` |

It is **not** exposed by `restApi.ts`, `importExport.ts` or the OpenAPI surface,
and decision emails never attach it (`tests/manual-review-1.md:91`). So folding
it into the thread has no external blast radius.

**Recommendation: yes, fold it in — but keep the column.**

- The reviewer's rationale becomes a thread comment posted at score-save time,
  stamped `kind='rationale'` with `plan_id` + `assignment_id`, so the
  score↔rationale link that made a per-review column useful still exists and an
  export can still join them.
- `reviews.comment` is **deprecated, not dropped**: it stops being written and
  stops being read, but the column stays. Dropping a column in SQLite/D1 means a
  table rebuild for no gain, and keeping it makes the backfill (§8) reversible.
- The D3 gate survives: writing your rationale never requires reading the thread.
  The composer on the score form posts blind; the thread unlocks on submit. That
  is the whole reason the rationale is a *distinct kind* rather than simply "the
  reviewer's first comment".
- Editing behaviour changes, and that is the one real cost: re-saving a score
  currently overwrites the comment, whereas append-only means a revised rationale
  appends a second `kind='rationale'` row. Suppress the no-op case — only append
  when the text differs from that assignment's most recent rationale.

`scoring_criteria.allow_comment` (`0001_init.sql:285`) is per-criterion, defaults
to 1 and appears unimplemented in the UI. Out of scope; leave it.

## 4. Schema — `packages/db/migrations/0013_submission_comments.sql`

```sql
CREATE TABLE submission_comments (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  -- Round context. Nullable: an organiser comment belongs to no round, and a
  -- plan deleted later must not take the discussion with it.
  plan_id           TEXT REFERENCES evaluation_plans(id) ON DELETE SET NULL,
  assignment_id     TEXT REFERENCES review_assignments(id) ON DELETE SET NULL,
  author_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  author_role       TEXT NOT NULL CHECK (author_role IN ('reviewer','admin','owner')),
  author_name       TEXT,
  kind              TEXT NOT NULL DEFAULT 'discussion'
                      CHECK (kind IN ('rationale','discussion')),
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_submission_comments_submission ON submission_comments (submission_id, created_at);
CREATE INDEX idx_submission_comments_event ON submission_comments (event_id, created_at);
CREATE INDEX idx_submission_comments_author ON submission_comments (author_contact_id);
```

Plus the §8 backfill in the same migration.

## 5. API work

### 5.1 Guard

`apps/api/src/routes/adminApi.ts:31-37` lets reviewers reach only
`/app/api/review/*` and `/app/api/me`. Reviewer-facing comment endpoints
therefore live **under `/app/api/review/`** — no carve-out, no new guard logic.

### 5.2 New module `apps/api/src/submissionComments.ts`

Mirrors `fileVersions.ts`:

- `loadThread(db, submissionId)` — ordered by `created_at, id`
- `addComment(db, opts)` — trim, cap at 2000 chars, empty → `null`
- `canReviewerSeeThread(db, contactId, submissionId)` — D3: true when the
  reviewer holds an assignment on this submission with `status='complete'`, or
  when every plan they are assigned to for it has `closes_at` in the past. Reuse
  the window logic already behind `plan_window_reason` in the review queue
  (`evaluation.ts:1421-1440`) rather than re-deriving it.

### 5.3 Endpoints

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/submissions/:id/detail` | admin/owner | add a `comments` array to the existing `Promise.all` at `evaluation.ts:607-645` |
| POST | `/app/api/submissions/:id/comments` | admin/owner | `author_role` from session; returns the refreshed thread |
| GET | `/app/api/review/assignments/:id/comments` | reviewer | 403 `review_not_submitted` when D3 says no |
| POST | `/app/api/review/assignments/:id/comments` | reviewer | same gate; stamps `plan_id`/`assignment_id` |

`POST /review/assignments/:id` (`evaluation.ts:1545`) additionally appends the
`kind='rationale'` comment described in §3, in the same request, after the review
upsert succeeds.

Every write calls `bumpEventRevision`, as the neighbouring routes do.

## 6. Admin UI

- `apps/admin/src/api.ts` — a `SubmissionComment` interface, `comments` on
  `SubmissionDetail` (near line 485), and `addSubmissionComment(id, body)`.
- `apps/admin/src/workspace/extras.tsx:417` `SubmissionDetailPanel` — a thread
  section below the review summary, using the `.file-comment` CSS. Label it
  clearly ("Discussion") so it reads as distinct from `submissions.notes`, which
  stays what it is: a writer-only private scratchpad (`adminApi.ts:973`).
- Optional and cheap: a comment-count column on the submissions grid, the way
  `filesAdmin.ts:65` counts file comments.

## 7. Reviewer UI

`apps/admin/src/review/ReviewerWorkspace.tsx`:

- The existing comment `<textarea>` (line 223) is relabelled as the rationale and
  keeps posting through `saveReview` — the wire field stays `comment`, so
  `saveReview`'s signature does not change.
- Below the scoring form, a thread panel in one of three states:
  1. not yet submitted → placeholder: "Post your review to join the discussion."
  2. submitted, or round closed → full thread + composer
  3. round not yet open → the same window notice the form already shows
- State 1 must not leak counts, authors or excerpts. The gate is server-side
  (§5.2); the client never receives the rows.

## 8. Backfill

In migration 0013, after the `CREATE TABLE`:

```sql
INSERT INTO submission_comments
  (id, event_id, submission_id, plan_id, assignment_id, author_contact_id,
   author_role, author_name, kind, body, created_at)
SELECT
  'sc-' || r.id, p.event_id, r.submission_id, r.plan_id, r.assignment_id,
  r.reviewer_contact_id, 'reviewer',
  NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
  'rationale', r.comment, r.created_at
FROM reviews r
JOIN evaluation_plans p ON p.id = r.plan_id
LEFT JOIN contacts c ON c.id = r.reviewer_contact_id
WHERE r.comment IS NOT NULL AND TRIM(r.comment) != '';
```

Deterministic id (`'sc-' || r.id`) so a re-run cannot duplicate. `author_role` is
hardcoded `'reviewer'` because that is what a row in `reviews` means, whatever
seat the contact holds today. Seed data (`seed.sql:494`) flows through this
automatically — no seed edit needed, but a fresh local re-seed should be checked
(§9).

## 9. Tests

Workers project (`vitest --project workers`):

- thread round-trips: post → appears in `/submissions/:id/detail`
- event scoping: a comment on event A's submission is invisible to an event B session
- reviewer gate: assignment `pending` → 403 on GET and POST; after
  `status='complete'` → 200 with rows; closed round → 200 even while pending
- rationale: saving a score appends exactly one `kind='rationale'` row; re-saving
  identical text appends none; re-saving changed text appends one more
- body validation: empty/whitespace → field error, not 500; >2000 chars truncated
- append-only: no route exists that updates or deletes a comment
- backfill idempotence: applying 0013 twice leaves one row per seeded review comment

UI project (`vitest --project ui`), alongside
`apps/admin/src/workspace/SubmissionDetailPanel.test.tsx`:

- detail panel renders the thread, shows the empty state, and posts a comment
- reviewer workspace shows the locked placeholder pre-submit and the thread
  post-submit, and the locked state contains no author names or bodies

## 10. Open questions

1. **Reviewer names vs pseudonyms** (D6). Conferences usually show "Reviewer 1/2/3"
   during discussion. Names are fine for a small committee, and the schema stores
   the contact id either way, so flipping later is display-only. Note that
   `anonymise_submitters` anonymises *submitters to reviewers* and says nothing
   about this direction.
2. **Do organiser comments appear to reviewers?** Simplest is yes, once the gate
   is open — one thread, one order. The alternative (an organiser-only side
   channel) is what `submissions.notes` already is, so no new mechanism is needed
   for it.
3. **Notification.** Nothing pings a reviewer when someone replies. Out of scope
   here; `apps/api/src/jobs/reminders.ts` is where it would go.

## 11. Sequencing

| Step | Work | Rough size |
| --- | --- | --- |
| 1 | Migration 0013 + backfill | S |
| 2 | `submissionComments.ts` + admin GET/POST | S |
| 3 | Detail panel thread UI | S |
| 4 | Reviewer endpoints + D3 gate | M |
| 5 | Reviewer workspace thread + rationale rewiring | M |
| 6 | Tests (§9) | M |

Steps 1–3 are independently shippable and useful on their own; the reviewer half
(4–6) is where the judgement calls sit. If the gate turns out to be more friction
than it is worth for a small committee, it can be relaxed to "always visible"
without touching the schema.

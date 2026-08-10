# Workplan 5 — org-level contact identity (2026-08-10)

Goal: **one contact record per person per organisation**, so a contact's submissions,
sessions and history can be viewed across every event in the org. Per-event profile
fields move to the `event_contacts` join table rather than being flattened away.

Prerequisite context: `docs/13` A1 (multi-event is real, schema already supports it),
`docs/15` §Tier-2/5 (cross-event speaker identity listed as unbuilt). Nothing in `docs/`
specifies the current per-event pinning — it falls out of `contacts.event_id`.

---

## 1. Target schema

```sql
contacts (
  id, org_id,                         -- was event_id
  email,                              -- UNIQUE (org_id, lower(email))
  first_name, last_name,
  salutation, honorific, pronouns, gender,
  mobile_phone, links,
  created_at, updated_at
)

event_contacts (                      -- new: membership AND per-event profile
  event_id, contact_id,               -- PRIMARY KEY (event_id, contact_id)
  biography,
  headshot_asset_id,
  company, job_title,
  added_at, source                    -- source: import|cfp|admin|migration
)
```

Field split rule: identity → `contacts`; anything a person can legitimately have a
different answer for at two events → `event_contacts`.

`event_users` stays separate — it is role plus `invited_at`/`accepted_at`, a different
lifecycle from presence. A staff member simply has a row in both.

`contact_field_values` is unchanged: it is keyed `(contact_id, field_id)` and `field_id`
is event-scoped, so per-event custom values already coexist correctly on one contact.

### Why the profile fields live on the join table

1. **The read becomes self-guarding.** Today `contacts.event_id` does double duty as the
   tenancy guard (`WHERE id = ? AND event_id = ?`) and as the membership filter. Flat
   org-scoping would require triaging ~62 call sites into one meaning or the other by
   hand, and any miss silently widens access from event to org. With profile columns on
   `event_contacts`, the canonical read is
   `FROM contacts c JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?`
   — the join is the guard *and* the fetch, so omitting the check costs you the columns
   you came for.
2. **Headshots keep working untouched.** `file_assets` is event-scoped and `fileAuth.ts`
   guards on `actor.eventId`. An org-level `headshot_asset_id` would 403 when viewed
   from a second event. An event-scoped pointer means `fileAuth.ts` needs no change.
3. **The migration is non-destructive.** Flat org-scoping forces electing one
   `job_title`/`biography` per person at merge time and dropping the rest. Splitting
   preserves every original value.

### Decided semantics

- **No read-time fallback.** A NULL `biography` on `event_contacts` means "no bio for
  this event", never "inherit from another event". Fallback-at-read turns every contact
  query into a correlated subquery and makes "clear my bio for this event"
  inexpressible.
- **Seed-on-create instead.** When a contact is added to an event, copy the profile
  fields from their most recent `event_contacts` row in the same org (§4, helper
  `seedEventProfile`). Required — without it a returning speaker retypes everything.
- **Dedupe scope moves from event to org**: "lower-cased email within the event"
  (`docs/06:193`) becomes within the org. Contacts never span orgs.

---

## 2. Migration `0013_org_contacts.sql`

18 live tables carry a contacts FK:

| ON DELETE CASCADE | ON DELETE SET NULL |
|---|---|
| `event_users`, `portal_accounts`, `contact_tags`, `submission_participants`, `review_assignments`, `reviews`, `task_assignments`, `portal_form_responses`, `file_request_uploads`, `calendar_invites`, `auth_tokens`, `contact_field_values`, `evaluation_plan_reviewers` | `submissions.submitter_contact_id`, `file_assets.uploaded_by_contact_id`, `message_log.contact_id`, `api_tokens.created_by_contact_id`, `file_comments.author_contact_id` |

Steps, in this order:

1. **Snapshot.** `CREATE TABLE _contacts_premerge AS SELECT * FROM contacts;` Keep it —
   it is the only record of the pre-merge split and the only way to review a bad merge.
2. **Elect survivors.** Group `_contacts_premerge` by
   `(events.org_id, lower(trim(email)))`; survivor = lowest `created_at`, tie-broken by
   `id`. Materialise `_contact_merge_map (old_id, new_id, org_id, event_id)`.
3. **Repoint children — before any delete.** `UPDATE <t> SET <col> = (SELECT new_id …)`
   across all 18 tables. Doing this after the delete destroys data silently via the 13
   CASCADEs. Watch the constraints the merge can now violate:
   - `submission_participants UNIQUE (submission_id, contact_id, role)`
   - `calendar_invites UNIQUE (session_id, contact_id)`
   - `review_assignments UNIQUE (plan_id, submission_id, reviewer_contact_id)`
   - `task_assignments UNIQUE (task_id, contact_id, COALESCE(submission_id,''))` (0005)
   - `contact_field_values PRIMARY KEY (contact_id, field_id)`
   - `evaluation_plan_reviewers PRIMARY KEY (plan_id, contact_id)`
   - `contact_tags PRIMARY KEY (contact_id, tag_id)`
   - `event_users PRIMARY KEY (event_id, contact_id)`

   These only collide when two merged rows sat in the *same* event, which the old
   `UNIQUE (event_id, email)` prevented — except via differing case or whitespace in the
   email. Use `INSERT OR IGNORE` plus delete-loser per table and assert zero unexpected
   drops.
4. **Build `event_contacts`** from `_contacts_premerge`: one row per original row,
   `event_id` = its old `event_id`, `contact_id` = mapped survivor, profile columns
   copied verbatim, `source='migration'`.
5. **Rebuild `contacts`** (SQLite cannot alter FK/UNIQUE): new table per §1, copy
   survivor identity columns, `org_id` from the old event's org, drop, rename. The FK to
   `events` is **removed** — keeping `ON DELETE CASCADE` would mean deleting one event
   wipes contacts belonging to the whole org.
6. **Re-create indexes**: unique `contacts(org_id, lower(email))`;
   `event_contacts(contact_id)` for the cross-event lookup; `event_contacts(event_id)`
   for the roster.
7. Run inside a transaction with `PRAGMA defer_foreign_keys = ON`.

**Post-migrate verification** (add as a checked script under `tests/`):

- every `_contacts_premerge.id` appears exactly once in `_contact_merge_map`
- `COUNT(event_contacts) == COUNT(_contacts_premerge)`
- per FK table: orphan count = 0
- per FK table: row count unchanged except where a documented dedupe applied

---

## 3. Application sweep

~62 sites reference contacts together with an event id. Triage each into one of three
shapes — do not sed this.

| Shape | Old | New |
|---|---|---|
| Fetch + guard | `SELECT * FROM contacts WHERE id = ? AND event_id = ?` | `FROM contacts c JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?`, explicit column list |
| Roster listing | `FROM contacts c JOIN events ev ON ev.id = c.event_id` (`adminApi.ts:205`) | `FROM event_contacts ec JOIN contacts c ON c.id = ec.contact_id WHERE ec.event_id IN (…)` |
| Org-wide lookup | n/a | `FROM contacts WHERE org_id = ?` — new, for the cross-event views |

| File | Work |
|---|---|
| `packages/db/src/index.ts` | `upsertByEmail(eventId, email)` → `upsertByEmail(orgId, email)` plus `attachToEvent(eventId, contactId)`; `getById` gains an event arg for the profile join |
| `apps/api/src/routes/adminApi.ts` (72 hits) | roster query `:205`; upsert `:730`; PATCH `:779`; delete `:838`/`:865` — delete now means *detach from event*, not destroy the person; per-event counts `:1981` |
| `apps/api/src/routes/restApi.ts` | `:354/:435/:464/:477/:482` guard rewrite; the public API contract keeps `event_id` in the response, sourced from `event_contacts` |
| `apps/api/src/routes/portal.ts` | `:296` whole-row read → aliased join (both tables have `created_at`/`updated_at`); profile save `:739` splits across two statements; guard `:293` per §5 |
| `apps/api/src/importer.ts` | `CONTACT_WRITABLE` splits into identity vs profile lists; `:536` dedupe lookup by org; `:646`/`:656` become two writes |
| `apps/api/src/routes/submit.tsx` | CFP account step: upsert by org, attach to event, seed profile |
| `apps/api/src/access.ts` | staff query unchanged in meaning; contact resolution now per-event |
| `fileAuth.ts`, `fileVersions.ts`, `filesAdmin.ts`, `publicAssets.ts` | no change expected given the event-scoped headshot pointer — verify |
| `jobs/reminders.ts`, `jobs/bulkJobs.ts`, `scheduleMail.ts`, `messagingAdmin.ts`, `evaluation.ts`, `agenda.ts`, `dashboard.ts`, `embed.ts`, `landing.tsx` | guard rewrite only |
| `packages/db/seed/seed.sql` | contacts seeded per org plus `event_contacts` rows; the two demo logins must survive (`DEMO_RESET` carve-out in `auth.ts`) |
| `apps/api/test/fixtures*.ts` (3 files) | build contacts org-scoped and attach; every contacts test follows |

**Tag scoping.** `contact_tags(contact_id, tag_id)` with event-scoped `tags`. After the
merge one contact carries tags from several events, so every filter-by-tag query needs a
`JOIN tags t … WHERE t.event_id = ?` it does not have today. Audit all tag filters.

---

## 4. New surface

- `seedEventProfile(orgId, contactId, eventId)` — copy profile columns from the most
  recent `event_contacts` row in the org. Called from every attach path (admin add, CFP
  submit, import, participant add).
- Admin: **"Add existing contact to this event"** — an org-wide picker, since the person
  may already exist with no row for the current event.
- Admin contact detail: **cross-event history panel** — submissions and sessions grouped
  by event, joining on `contact_id` alone. This is the feature the workplan exists for.
- Contact delete splits into **detach from event** (drop the `event_contacts` row) and
  **delete from org** (destroy the person — only when no other event references them, or
  behind an explicit confirm listing the affected events).

---

## 5. Speaker portal, cross-event

Independent of the schema work but unlocked by it, and cheap once it lands.

- `portal.ts:293` currently pins the session (`session.eventId !== event.id`). Replace
  with a lookup of `event_contacts` for `(event.id, session.email)`; 401 to the login
  page when absent. `portal.ts` has **exactly one** `session.eventId` reference — every
  other scoping site already uses `ctx.event.id` from the URL slug.
- `PortalCtx` carries a resolved per-event `contactId`; the ~18 `ctx.session.contactId`
  call sites become `ctx.contactId`. Each is a security boundary — review individually.
- `files.ts:28` builds the `fileAuth` actor from `session.contactId`/`session.eventId`;
  same resolution.
- Accessible-events query becomes trivial: `SELECT event_id FROM event_contacts WHERE
  contact_id = ?`. Note this makes the switcher list disclose "event X has you on file",
  so gate the list on a real relationship (submission, task assignment, or `event_users`
  row) rather than bare membership.
- Session cookie shape is unchanged — `eventId` keeps meaning "current event", as it
  already does for staff. No re-mint, no forced logout.
- `requestMagicLink` (`auth.ts:63`) currently upserts a contact for *any* email against
  *any* event slug, creating empty rows. Restrict creation to the CFP submission path.
- Admin "View Portal" impersonation: verify `impersonatedBy` still resolves the right
  per-event contact.

---

## 6. Staging

Separate commits; each should leave the suite green.

| # | Step | Notes |
|---|---|---|
| 1 | Migration + verification script, no app changes | A compat `VIEW contacts_v AS SELECT c.*, ec.event_id, ec.biography, … ` can keep old code running if steps 1 and 3 need to be decoupled |
| 2 | `packages/db` API + fixtures + seed | |
| 3 | Guard sweep, read paths | Largest commit; the §3 table is the checklist |
| 4 | Write paths (PATCH, importer, portal profile, CFP) | |
| 5 | Detach-vs-delete, org picker, cross-event history panel | The user-visible payoff |
| 6 | Portal cross-event access (§5) | |

Estimate 2–3 days. Risk is concentrated in step 3: a missed guard widens access from
event to org silently and no existing test would catch it. Add a test asserting that a
session for event A cannot read a contact whose only `event_contacts` row is event B.

---

## 7. Docs to update

`docs/02-domain-model.md` (Contact table, new EventContact), `docs/06` speaker dedupe
(event → org), `docs/05` §1 access, `docs/13` A1 (assumption now exercised), `docs/15`
Tier-2 item 5 (mark delivered).

# Workplan 12 — Green Room view (mobile-first run-of-show screen)

## Context

Organisers at the conference need a phone-shaped screen for the day itself: who is on now/next in each room, has the speaker arrived, are their slides in, and how to reach them. `docs/15-winning-moves.md` (§2 move 6, §6) already identifies this as "the most phone-shaped screen in the product"; `docs/16-mobile-plan.md` scoped it out of the mobile-layout work. Nothing exists yet — no check-in state in the DB, no "now" indicator anywhere in the agenda UI.

**Decisions taken:** build on `main` (not `feat/mobile-responsive`, which has diverged); full scope — now/next board, speaker check-in, readiness flags, contact quick actions (tap-to-call + nudge). Since main's admin shell pins a fixed 184px sidebar with no media query, the green room carries its own scoped mobile layout without touching other views.

## 1. Migration — `packages/db/migrations/0019_greenroom_checkin.sql`

```sql
ALTER TABLE event_contacts ADD COLUMN arrived_at TEXT;           -- UTC ISO, NULL = not arrived
ALTER TABLE event_contacts ADD COLUMN arrival_marked_by TEXT REFERENCES contacts(id);
```

Column on `event_contacts` rather than a checkins table: arrival is single per-(event, contact) state like biography/headshot; undo is a NULL; no audit-history requirement; and the readiness query already joins `event_contacts` so the read costs zero extra joins.

**Airtable mirror: no wiring.** `event_contacts` is not in `SYNC_TABLES` (`packages/airtable/src/sync.ts`) and has no `updated_at`, so it can't ride the watermark sweep — note this deliberately in a migration comment.

## 2. API — new `apps/api/src/routes/greenroom.ts`

Mount in `apps/api/src/routes/adminApi.ts` beside line 101: one import + `adminApiRoutes.route('/greenroom', greenroomRoutes)`. Inherits the session guard (`session.eventId`), single-event like agenda/dashboard. Writes return the whole refreshed payload (the `agenda.ts` convention).

### GET `/app/api/greenroom`

ETag exactly like `dashboard.ts:411-417`: `"r${revision}"` from `getEventRevision` (`apps/api/src/revision.ts`), `if-none-match` → 304, KV payload cache keyed `greenroom:${eventId}:${revision}` (TTL 600).

**Key design choice:** return **all** scheduled sessions for the event, not a day window — the client derives "today" and now/next from the device clock. That keeps ETag polling correct: time advancing never invalidates the payload, only data changes do. Sessions are trimmed (no `description`).

```
{ now, event: {id,name,slug,timezone,starts_at,ends_at},
  rooms: [{id,name}],
  sessions: [{id,code,title,format,track_name,room_id,starts_at,ends_at,speaker_ids}],
    // accepted, starts_at & room_id NOT NULL, ORDER BY starts_at (idx_submissions_schedule)
  speakers: { [contact_id]: { name, email, mobile_phone, arrived_at, arrival_marked_by_name,
                              missing_bio, missing_headshot, missing_slides, outstanding } } }
```

Reuse:
- **Sessions**: `SESSION_SELECT`-shaped query (`agenda.ts:63`) + `LEFT JOIN tracks`; speakers stitched in JS like `loadSessions()` (`agenda.ts:71-92`).
- **Readiness**: extract the `speakerAgg` query from `dashboard.ts:99-146` into an exported helper `speakerTracking(db, eventId, now)`, consumed by **both** dashboard and greenroom so flags can never disagree. Extend its select with `c.mobile_phone, ec.arrived_at, ec.arrival_marked_by`. LEFT-JOIN semantics so a speaker with no `event_contacts` row still renders (readiness unknown) instead of vanishing.

### POST `/app/api/greenroom/checkin` `{ contact_id, arrived: boolean }`

`UPDATE event_contacts SET arrived_at = ?, arrival_marked_by = ? WHERE event_id = ? AND contact_id = ?` (arrived:false → both NULL). `meta.changes === 0` → 404 (doubles as tenant isolation, same shape as `agenda.ts:401-415`). Then `bumpEventRevision` and respond `{ ok, etag: "r<newRev>", ...fresh payload }` so the client swaps payload + etag atomically.

### POST `/app/api/greenroom/nudge` `{ contact_id }`

Single-contact inline send reusing the remind machinery (no bulk job): select that contact's incomplete assignments (predicate family of `expandRemindTasks`, `bulkJobs.ts:539-551`, **without** the overdue clause), prefer `file_upload`, cap ~3. Per assignment: `queueTemplated` with templateKey `'task_reminder'`, `version: 'manual-' + eventLocalDay(now, event.timezone)` (same day-keyed idempotency as `bulkJobs.ts:525/562` — double-taps dedupe via the `message_log` UNIQUE key), then `attemptImmediate` (`mailer.ts:215`). Response `{ ok, sent, duplicates }`; `400 nothing_to_nudge` when nothing incomplete; map `template_disabled` to its own error code. No revision bump.

## 3. Frontend — `apps/admin/src/greenroom/`

Files: `GreenRoomSection.tsx`, `logic.ts`, `greenroom.css`, `greenroom.logic.test.ts`, `GreenRoomSection.test.tsx`. In `apps/admin/src/api.ts`: `fetchGreenRoom(etag)` cloned from `fetchDashboard` (`api.ts:969-982`, returns `{fresh:false}` on 304), `greenroomCheckin`, `greenroomNudge`, `GreenRoomPayload` type.

**Poll loop** — copy `DashboardSection.tsx:195-238`: etagRef, self-rescheduling `setTimeout` ~15s with ±15% jitter, skip while `document.hidden`, immediate refetch on `visibilitychange`, "updated Ns ago" ticker. After a write, adopt the response payload + etag.

**Time model (`logic.ts`, pure, unit-tested):**
- Comparisons in UTC instants (`Date.now()` vs `Date.parse(starts_at)`) — device timezone irrelevant; event timezone is display-only.
- Display via `fmtRange`, `fmtDay`, `utcToLocal`, `eventDays`, `tzAbbr` from `apps/admin/src/agenda/timeUtils.ts` — never hand-rolled (handles the bare-date off-by-one trap).
- `windowByDay(sessions, tz)` → Map<localDay, sessions>; `deriveNowNext(daySessions, roomId, nowMs)` → `{current, next}` (current: starts ≤ now < ends, latest start wins; next: first future); `pickDay(daysWithSessions, todayLocalDay)` → today if it has sessions, else first future day, else last day; `telHref(mobile_phone)` null-safe, strips to digits + leading `+`.
- Auto-advance: 30s `setInterval` bumping `nowMs` re-derives now/next between polls.

**Components:** header (event name, day + tz, day chips when multi-day, "updated Ns ago", compact Menu button); `RoomLane` per room — "On now" card (highlighted, time remaining) + "Up next" + collapsed "N later today"; `SessionCard` (time range, title, code, format/track, speaker rows); `SpeakerRow` — arrival toggle ≥44px reading "Arrived 9:12 AM" (`--status-accepted-*`) / "Not arrived" (`--status-pending-*`), colour always paired with a label; readiness chips only when missing; `tel:` anchor only when `mobile_phone` present; Nudge button only when something is missing, with sent/duplicate feedback.

**Optimistic check-in:** flip locally, POST, adopt server payload on success, revert with inline error on failure; a `writeSeq` counter discards poll results resolving mid-write.

**Empty states:** no scheduled sessions → panel pointing at the Agenda; nothing today → "Nothing scheduled today — next: <day>" with jump chip; day finished → "Done for today" + tomorrow chip.

**Mobile treatment (scoped, other views pixel-identical):**
- `App.tsx:2119`: `<div className={'shell' + (view === 'greenroom' ? ' shell--greenroom' : '')}>` — the only shell-adjacent change; `shell.css` untouched.
- `greenroom.css`: `@media (max-width: 767px) { .shell--greenroom .shell-sidebar { display:none } .shell--greenroom .shell-main { padding:0 } }`; header Menu button toggles a `.gr-nav-open` class re-showing the sidebar as a fixed overlay (~15 lines, still scoped).
- Breakpoints 640/768/1080 (repo canon): single column <768, two-column room grid 768–1079, wide grid ≥1080 (backstage laptop). Tap targets ≥44px at every width. Tokens only → dark mode free.

## 4. Router / nav wiring

1. `apps/admin/src/router.ts:22` — add `'greenroom'` to `VIEW_KEYS`.
2. `App.tsx:220` — `NAV_ITEMS` entry `{ key: 'greenroom', label: 'Green Room', soon: null }` after Agenda.
3. `App.tsx` dispatch ternary (~2279) — `: view === 'greenroom' && !isReviewer ? (<GreenRoomSection key={me.event.id} />)`, bound to `scope.currentEvent` like DashboardSection.
4. The `shell--greenroom` className (§3).

## 5. Ordered steps (each independently verifiable)

1. Migration 0019 → workers harness applies it, existing tests green.
2. Extract `speakerTracking()` from `dashboard.ts`; dashboard consumes it → `dashboard-cache` + `dashboard-asset-completeness` tests unchanged.
3. GET `/greenroom` (payload, ETag, KV cache) + mount → new worker tests.
4. `/checkin` + `/nudge` writes → worker tests.
5. Client API additions in `api.ts` → typecheck.
6. `logic.ts` + logic tests → `unit` project green.
7. `GreenRoomSection.tsx` + `greenroom.css` (desktop-first, poll loop, optimistic writes, empty states) → render tests.
8. Wiring (router, nav, dispatch, shell class) → app renders, other views untouched.
9. Mobile pass: media queries, sidebar overlay menu, 44px audit → manual verify at 390px; desktop ≥1080 of other views pixel-identical.

## 6. Verification

- **Workers** (`apps/api/test/greenroom.test.ts`, patterned on `dashboard-cache.test.ts` with `fixtures-admin` seeds): ETag 200/304/bump-on-checkin; payload contains scheduled session with room/speakers, `mobile_phone`, `missing_slides`/`missing_bio`/`missing_headshot`; check-in sets/clears `arrived_at` + `arrival_marked_by`, foreign-event contact → 404; nudge queues `task_reminder` with `manual-<day>` key, same-day repeat dedupes, nothing outstanding → 400; readiness parity between `/dashboard` and `/greenroom` on the same fixture.
- **Unit**: `deriveNowNext` boundaries (exact start/end, back-to-back, gap, overlap); `windowByDay` across a timezone day boundary; `pickDay` pre/mid/post-event; `telHref` variants.
- **Render** (`ui` project, mocked fetch): room lanes + now/next from fixture; optimistic check-in flip + revert on failure; empty-today → next-day state.
- **End-to-end**: `npm run migrate:local && npm run seed:local`, run dev, open `/app?v=greenroom`, verify at 390px (browser devtools) and desktop; confirm other admin views unchanged at 1280px.

## Risks

- **Timezone math**: only via `utcToLocal`/`eventDays`/`eventLocalDay`; comparisons stay in UTC instants.
- **ETag granularity**: revision is event-wide, so any admin write refetches — acceptable (trimmed payload, KV-cached per revision).
- **Empty `mobile_phone`**: tel affordance renders only when present.
- **Speaker missing `event_contacts` row**: stays visible via LEFT JOIN; check-in 404 surfaces as "not on the event roster".
- **Nudge template disabled**: distinct error code, shown inline.

# Admin Workspace Smoke Plan (post-fix-batch)

Additive browser-pilot plan covering the surfaces changed by the 2026-08 fix batch
(workspace redesign, URL routing, agenda queue/guard, inline-edit reliability,
portal hardening). Run against local `wrangler dev` after `npm run build`,
`npm run migrate:local`, `npm run seed:local`. Sign in via the DEV_MODE magic-link
flow as the seeded owner. Each step states its pass condition; screenshot failures
into `tests/screenshots/smoke-01/`.

## A. Auth & routing

1. Request a magic link, open it → signed in. Open the SAME link again in a fresh
   private window → the used/expired page, no session. (Single-use tokens.)
2. In the app, open Workspace → Submissions, select a row, note the URL gains
   `v=workspace&tab=submissions&rec=…`. Reload → same tab open, same record's
   detail tab open. Browser Back → returns to Dashboard (or prior view), Forward
   restores.
3. Copy the URL into a second tab → identical state (deep link).

## B. Event filter model

1. The sidebar event dropdown shows the current selection and always includes
   "All events". Select "All events" → workspace tabs show an Event column;
   rows from every accessible event appear (seed has one event — verify the
   column renders and the chip in the tab-header row says "All events").
2. Create a second event via "+ New event" (fill FR-EVT-2 fields; try a duplicate
   slug first → inline "slug taken" error; then a unique slug) → dropdown gains
   the event, filter switches to it, per-event sections (Dashboard/Agenda) show
   that event's name — all WITHOUT a full page reload.
3. Select the original event again → workspace narrows; the header chip shows the
   event name.

## C. Workspace interactions

1. Type in the workspace search box → active tab filters via `q` (e.g. a speaker
   name); URL gains `q=`; reload preserves the search.
2. Inline-edit a submission's status → brief pending state, then persisted
   (reload to confirm). Now stop the dev server, edit another status → the cell
   reverts and an error is announced/visible; restart the server.
3. Right-click a workspace tab → context menu shows Detail (hint "double-click"),
   Make global filter (hint "Shift-click"), Add to filter (hint shows ⌘-click on
   Mac / Ctrl-click elsewhere), Close tab. Full keyboard pass: open the menu,
   Arrow through items, Enter activates, Escape closes and restores focus.
4. Keyboard-only tab strip: Tab to the strip, Arrow Left/Right moves between
   tabs, Home/End jump, Enter opens.
5. Speakers tab: create a speaker with an invalid email (`x@x`) → inline format
   error blocks save; fix it → saves. Open the detail, add Internal notes on a
   submission detail panel → Save persists (reload to confirm). Verify the notes
   never appear in that speaker's portal (see F.3).
6. Tasks tab: "+ New task" creates a task definition; it appears after refresh.
7. Delete a speaker who has submissions/reviews/tasks → succeeds with the
   corrected confirm copy (participant links removed). Record the HTTP result of
   any failure — the original manual-review delete bug was never reproduced
   backend-side.

## D. Agenda

1. Drag a session around the day grid rapidly → ghost preview stays smooth,
   conflicts appear only for the dragged session, no flicker; drop persists.
2. Move dialog (M or Enter on a focused block): set Duration to 0 → snaps to 5 on
   blur; set Capacity → persists.
3. Publish control: header shows Draft; Publish → chip flips, and
   `/e/<slug>/agenda.json` now returns JSON (404 before). Unpublish → 404 again.
4. Send confirmations → button reports a queued job and polls progress; within
   ~2 minutes invites exist (message log / mail console) and the board reloads
   with invited badges.
5. THE M4.9 REGRESSION CHECK: immediately after step 4's click (before the job
   finishes), move an invited-to-be session via the Move dialog → once invites
   exist server-side, a move without choosing notify must be refused and the
   notify prompt must appear (server 409 → re-prompt). An invited session must
   never move silently by any path (drag, dialog, undo).
6. Ctrl-Z after a move → position restores and persists.

## E. Public form (CFP)

1. Open the public submit form. Stepper is keyboard-operable (buttons,
   aria-current). Add a participant beyond the configured role max → blocked
   with a message.
2. Builder check: add a required participant-section question to the form, reload
   the public form → the new question renders for each participant and blocks
   submit when empty; the submitted answer appears in the admin submission
   detail. (Participant-contract end-to-end.)
3. Submit twice rapidly (double-click submit) → one submission, one confirmation
   email, same code shown.
4. Open the confirmation email's portal button in a fresh private window → lands
   authenticated in the speaker portal (no second sign-in).

## F. Portal

1. Profile: submit an invalid website URL → page re-renders with the value
   preserved, an error summary linking the field, and focus on the summary.
2. Submission editing: as the speaker, edit an ACCEPTED submission → allowed,
   saves; a declined one shows no edit affordance and direct URL access is
   refused.
3. Internal notes redaction: with notes set on this speaker's contact and
   submission (C.5), view profile + submission pages → the notes text appears
   nowhere in the HTML.
4. Task upload: a file request restricted to PDF rejects a PNG with copy showing
   the actual limit/types (not "max 20 MB" boilerplate).

## G. Files

1. As a speaker, fetch another speaker's headshot URL (`/files/<id>` taken from
   admin) → 404. As admin the same URL serves the image.

# Issues list — full eval run 2026-08-12T23-01-47-hwil15

Source: `C:\dev\killmysaas-evals\runs\2026-08-12T23-01-47-hwil15` (overall 92.2% @ 96.3% coverage).
Compiled from the judge's defect reports plus fail/partial rubric items. Harness-side coverage
gaps (turn-limit cutoffs, unclicked buttons) are listed separately at the end — they are not
product defects.

## Major defects (7)

1. **Reviewer sessions cannot reach their assigned event via the event switcher** — reviewer
   signed in as the Sam Whitfield fixture landed on a queue for the *wrong* event (AI.Engineer
   Sandbox), and picking "DevFlow Conf 2027" from the event filter raised "Event switch failed —
   forbidden". The dropdown offers an event the session can't switch to, leaving no UI path to
   the reviewer's queue; a fresh organizer-issued sign-in link was the only workaround.
   *(Abstract Mgmt — `/app?v=review` event filter)*

2. **Speaker Edit form silently clears Status on save** — Priya Raman's status was "Confirmed"
   before adding an internal note via Edit; after save it showed "—" with no warning. Unintended
   data loss on an unrelated field. *(Speaker CRM — CRM-S1 screenshots 025 vs 028/029)*

3. **Inline speaker Status dropdown can silently lose an update** — selecting "Confirmed" then
   navigating away quickly reverted it to blank; it only stuck after re-selecting and waiting
   ~1s. Unguarded debounced/async save with no pending/saved indicator. Likely the same root
   cause as #2. *(Speaker Mgmt — SPK-S1 screenshot 022)*

4. **Edit form does not re-populate saved social links** — LinkedIn and X/Twitter were saved
   (visible in the Detail Links block) but reopening Edit showed both inputs blank, so a
   subsequent save would wipe them. Same "edit form loses persisted values" family as #2.
   *(Speaker Mgmt — SPK-S1 screenshots 024 vs 023/026)*

5. **Custom speaker field never appears on the create/edit form** — a Select field "Speaker
   Type" (Internal/External) created in Settings > Speaker fields did not show up on the
   speaker edit form, contradicting the panel's own claim that changes appear immediately; no
   explicit save control was discoverable. Cost rubric items CRM-04 and SPK-15.
   *(Speaker CRM — CRM-S1 screenshots 032, 027)*

6. **Org-level contact profile error state and inconsistent event linkage** — Priya's
   "Across your events" section renders "The record no longer exists. Retry"; Marcus's
   org-level detail says "Events: On no event yet" while the directory row for the same email
   shows "2 events" and his sessions are listed below. *(Speaker CRM — CRM-S2 screenshots 019/021)*

7. **Bulk deliverables reminder is broken/misleading** — button labelled "Remind all
   outstanding (3)" reports "0 reminders sent." because the logic only targets *overdue* tasks
   (all due dates are 2027). No message record created; organizers cannot chase outstanding
   deliverables before the due date. Failed rubric item CNT-08 outright.
   *(Content Mgmt — Dashboard > Speaker Tracking)*

8. **Compose "Preview as" dropdown never loads** — permanently "Loading recipients…" with the
   Preview button disabled, so merge-field output cannot be previewed before sending. (Merge
   fields do resolve correctly in sent mail — SPK-14.) *(Speaker Mgmt — SPK-S3 screenshot 021)*

## Minor defects

### Data association / scoping
9. **Uploaded deliverables not associated with sessions** — SESS-2's Files section says "No
   files uploaded" even though the assigned speaker uploaded slides.pdf against that session's
   task; the central Files library has no session column. AV/web teams can't tell which session
   a deck belongs to. Capped CNT-13 at partial. *(Content Mgmt)*
10. **Bulk message from "All events" context logged against the wrong event** — all 12 sends
    resolved and logged against AI.Engineer Sandbox instead of the DevFlow event named in the
    subject; recipient-group event scoping is implicit and misleading. Also noted in CRM-11.
    *(Speaker CRM — CRM-S2 screenshots 023, 025)*
11. **Cross-round bleed in reviewer discussion panel** — while scoring SESS-2 in Initial
    Review, the Discussion panel showed rationale text from the earlier Program Committee round.
    *(Abstract Mgmt)*
12. **Speaker profile bio not joined with submission-level bio** — portal Profile widget warns
    "Your bio or headshot is missing" although a bio was supplied (and required) on the
    submission wizard's Participant step; implies two separate bio stores. *(CFP — SPK portal)*
13. **CSV import dedupes strictly by email** — re-importing the same people under different
    addresses silently creates duplicate contacts (two Priya, two Marcus) with no near-duplicate
    warning. *(Speaker CRM — import)*

### Workflow gaps
14. **No "Declined/Rejected speakers" audience preset** — only "Accepted speakers" exists, so
    rejection emails require hand-picking recipients. Noted again under CFP-14. *(CFP — Messages
    compose)*
15. **Directory grid has no checkbox multi-select** — the "select 2+ contacts → email" path
    doesn't exist; bulk email only works via audience groups. *(Speaker CRM — CRM-11)*
16. **Status not settable at create time / absent from Edit form** — status is only an inline
    dropdown on Detail; imported/added contacts land with status "—". *(Speaker Mgmt)*
17. **Reviewer provisioning has no organizer-set credential path** — only a single-use
    15-minute magic link the organizer must relay manually; if it expires the reviewer has no
    self-service way in. *(CFP — Evaluation > Reviewers)*
18. **No global file-collection setting** — file collection only configurable per task via
    "Action type = File upload". *(Content Mgmt)*
19. **No saved/pre-built template picker in compose** — bodies are typed by hand; system
    templates only appear as a log column. *(Speaker Mgmt — SPK-14)*

### UI/UX polish
20. **Auto-place chose 6:00–6:10 AM** for an unscheduled lightning talk — start of the visible
    axis rather than a sensible daytime slot — and that slot went out on the published public
    agenda. *(AI Agenda)*
21. **"+ Add room" instantly creates a live schedulable placeholder room** ("New room 5/6")
    before naming; accidental clicks create real rooms that must be deleted via a confirm
    dialog. *(AI Agenda — Settings > Rooms)*
22. **Room double-booking allowed with only a warning** — two sessions render split-width in
    the same room/time and the agenda can still be published; no hard block or save-time guard.
    *(AI Agenda)*
23. **Public CFP form heading is "Untitled form"** on the branded portal and in the organizer's
    forms list. *(CFP)*
24. **Round date inputs auto-save keystrokes** — datetime fields commit on change with only a
    small toast and no save/cancel, so a partially typed date can be committed as the round's
    close date. *(Abstract Mgmt — Evaluation round cards)*
25. **Record panels hang in "Loading…"** — speaker detail's Sessions / "Across your events" /
    Content history blocks and roster/tasks lists showed indefinite "Loading..." states after
    navigation. *(Speaker Mgmt — SPK-S3 028/032, SPK-S1 020)*
26. **Fixture marker text on a public page** — "SBEK-PORTAL-BIO-01" renders inside Priya's
    public speaker bio (gallery modal and directory detail). Content-hygiene; will disappear on
    demo reset but indicates portal bio edits flow to public unfiltered. *(Public Widgets)*
27. **.ics export gives no feedback** — "Export my schedule (.ics)" downloads silently with no
    on-page confirmation. *(Public Widgets — itinerary)*
28. **Session card with no description shows nothing** — one published session renders with no
    abstract and no placeholder while sibling cards have description + Show more. *(Public
    Widgets — sessions list)*
29. **Edit Submission Track select initially shows "— No track —"** despite the detail showing
    Track = "Platform & Infra" — risk of silently dropping the track on save (value did appear
    in a later render). *(Content Mgmt)*
30. **Participant role vocabulary degenerate** — portal "Add co-author" Role dropdown offers
    only "Speaker"; co-authors/co-presenters can't be labelled distinctly. *(Abstract Mgmt)*
31. **CNT-12 partial**: the "Visible in public agenda" approval gate exists but was never
    demonstrated actually excluding a session — the app attributed SESS-5's absence to it being
    unscheduled. Worth a targeted manual/e2e check rather than a code change.

## Coverage gaps, not product defects (from partial items)

These went partial because the agent ran out of turns or didn't click, not because anything
failed — they're candidates for the manual checklist / a follow-up targeted run:
- **ABS-08/ABS-09**: reviewer-progress before/after pairing and "Remind all lagging" send never
  exercised (ABS-S2 turn limit).
- **ABS-13**: Reviews/Submissions CSV/XLSX buttons exist but were never clicked.
- **CRM-06**: DUPLICATES button and merge flow never opened (turn limit) despite real dupes
  being present.
- **CNT-14**: bulk ZIP download confirmed by banner; ZIP contents unverifiable in-browser.
- **EMB-04**: speakers directory verified except headshot-per-entry (screenshot not attached).
- **SPK-02**: manual "New Speaker" form inspected but deliberately not submitted.
- **ABS-14** (`not_found`): no AI-triage claim anywhere in the UI — recorded as not applicable,
  no action.

Manual checklist for the run has **20 items** (`manual-checklist.md`); `finalize` not yet run.

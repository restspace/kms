# Workplan 14 — Features deferred from the 2026-08-12 eval defect sweep

Status: **built 2026-08-12** — all five waves implemented and green (workers
637, unit+ui 528, both typechecks clean); migrations landed as
`0030_contact_merge.sql` + `0031_revisions_entity_type.sql`, pending on remote
D1 along with 0026/0029. F9 rejected per D4. Notable build findings: the F5
"decided-status gate" never existed (the gap was traceability only, now
revision-recorded); compose has no stored-template concept so D3's template
picker clause is N/A; feed URLs deliberately do not carry show_*/theme params. Commit `b815e77` fixed 30 of the 33 defects the
sbek judge logged (run `2026-08-12T09-11-31-BFqRwm`, overall 83.8%). What
remains here is the work that was correctly refused during a bug-fix pass:
things that need a design decision, a new surface, or a migration that
shouldn't be improvised by a subagent on a deadline. Plus two small items the
sweep partitioning simply missed.

**Framing principle:** the sweep fixed the places the tool *lied* (saves that
didn't save, counts that didn't count, "complete" that wasn't). This plan is
about the places the tool is *mute*: duplicates it can see but can't merge,
emails it sends but won't show you first, schedule facts speakers can't see,
history it records for only one entity.

## 0. Inventory — what was deferred and why

| # | Item | Origin | Why it was deferred |
| --- | --- | --- | --- |
| F1 | Contact merge/dedupe tool | CRM minor "no duplicate detection... no merge remedy" | A merge touches every FK that points at a contact; needs the 0015 merge-map treatment, not an afternoon |
| F2 | Per-recipient pre-send preview + template picker | SPK minor "no way to verify personalized content" | Needs a server-side render-preview endpoint; the after-send half (persisted rendered bodies, 0029) already landed |
| F3 | Embed field-visibility toggles + custom CSS | EMB minor | No per-field options mechanism exists to extend; custom CSS is an injection surface the accent param deliberately avoids |
| F4 | Speaker portal shows room + scheduled time | SPK minor — **missed by the sweep**, not deferred | Fell between two agents' file domains |
| F5 | Post-decision edit path for participants | ABS minor "co-author cannot be added after acceptance" | Product policy, not a bug: post-decision immutability is deliberate; needs a scoped exception |
| F6 | Revision history beyond title/description | CNT major, half-landed | 0023 records submissions only; bios/settings need server-side recording (migration) |
| F7 | Headshot POST + detail sub-reads still session-event-scoped | flagged by the contacts agent | Same defect class as the fixed critical contacts bug; untouched because it wasn't in the defect list |
| F8 | Files library "Add new record" | CNT minor, half-landed | The submission-detail upload control landed; a library-level control needs a target picker (which chain/contact/submission?) |
| F9 | Reviewer password auth option | CFP minor "no password option" | Conflicts with the app's auth model — see D4 |
| F10 | FormBuilder new-form default roles | CFP agent note | Core default now includes co-author etc.; the admin RolesPanel still seeds new forms speaker-only |

## 1. Decisions

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Merge (F1) reuses the 0015 machinery pattern: keep `_contact_merge_map`-style audit, losing record tombstoned not deleted | Every FK repoint is recorded and reversible in principle; the public agenda/JSON stops showing two Priya Ramans without history loss. The new-contact duplicate warning banner becomes the entry point ("Merge instead?") |
| D2 | Merge is org-scoped and organizer-driven; no auto-merge | The import 409 `plan_changed` fix already stops new machine-made duplicates; auto-merging existing ones risks fusing two real people with the same name. Candidate list = same normalized email (strong) or same normalized name (weak, needs human confirm) — the same tiers the agenda conflict engine now uses |
| D3 | Preview (F2) renders server-side via the exact code path that sends (`queueTemplated`'s renderer), never a client-side reimplementation | The preview can't drift from the send. Endpoint: `POST /app/api/messaging/preview` with `{template/body, contact_id}` → rendered subject/body for that recipient. Compose UI gets a recipient-picker dropdown over the current selection |
| D4 | F9 (reviewer passwords) is **rejected**, not deferred | The app is magic-link/session everywhere; a parallel password store for one persona is a security surface with one beneficiary. The real complaint was the truncated unreadable link, which the sweep fixed (selectable full URL + copy). Revisit only if a customer asks |
| D5 | Custom CSS in embeds (F3) ships as a **preset theme + CSS custom-properties allowlist**, not free-form CSS | The loader already isolates widgets; free-form CSS through a query param is a stored-XSS invitation. `data-*` attrs for a fixed set of tokens (font, radius, spacing, muted color) covers the actual ask ("branding customisation") |
| D6 | Field toggles (F3) ride the existing `EventPageOptions` plumbing: new boolean query params parsed in `parsePageOptions`, honoured per widget, emitted by the builder as `data-*` | One mechanism end-to-end; the builder's snippet and direct link stay consistent (the sweep already unified filter expression) |
| D7 | F5: participants become editable post-decision **by the organizer only**, and the edit is revision-recorded | Speakers stay locked (the immutability promise to reviewers holds); the organizer already has edit powers elsewhere and the actual eval scenario was an organizer-side task. Cheap: drop the status gate on the organizer participants endpoint, add the revision row |
| D8 | F6 records revisions for `event_contacts` profile fields (bio, company, job_title) and event settings, reusing the 0023 table with an `entity_type` discriminator (new migration) | One history UI (the sweep's `ContentHistorySection`) renders all of them; no second table, no second component |

## 2. Waves

### Wave A — small trues (½ day, no migration)
Ship together as one commit; each is under ~40 lines.
- **F4** portal session detail: render `starts_at`/`ends_at`/room when the
  agenda is published and the session is scheduled ("Scheduling TBC" otherwise).
  Read side only; data is already in the row.
- **F7** headshot POST + contact detail sub-reads honour the row's `event_id`
  exactly as the fixed contacts PUT now does (same `requireEventAccess` guard,
  same 404-on-zero-write rule). Add the cross-event test alongside
  `contact-speaker-defects.test.ts`.
- **F10** RolesPanel seeds new forms from `DEFAULT_PARTICIPANT_ROLES` instead
  of its own speaker-only literal.
- **F5** per D7: organizer participants endpoint drops the decided-status gate,
  writes a revision row; speaker portal unchanged.

### Wave B — contact merge (F1, ~2 days, migration 0030)
1. `0030_contact_merge.sql`: `contact_merges` audit table (winner, loser,
   actor, timestamp, field-resolution JSON).
2. `POST /app/api/contacts/:id/merge` — org-scoped, writer-gated: repoints
   `event_contacts`, `submission_participants`, `task_assignments`,
   `message_log`, file chains; field conflicts resolved by an explicit payload
   (UI sends the organizer's picks); loser tombstoned (`merged_into`).
3. UI: "Duplicates" panel on the Speakers tab (candidates per D2 tiers) +
   "Merge instead?" action on the existing duplicate-name warning banner.
   Side-by-side field picker, then confirm.
4. Tests: repoint completeness (every FK table), tombstone invisibility in
   directory/public feeds, audit row shape, weak-match requires confirm.

### Wave C — pre-send preview (F2, ~1 day, no migration)
1. `POST /app/api/messaging/preview` per D3.
2. Compose UI: "Preview as <recipient ▾>" above send; renders subject + text
   body with merge fields resolved; template picker if more than one template
   matches the context.
3. Test: preview output byte-equals the body later persisted by 0029 for the
   same recipient.

### Wave D — embed customization (F3, ~1–2 days, no migration)
1. `parsePageOptions`: `show_abstract`, `show_speakers`, `show_room`,
   `show_track` booleans (default true) + `theme` token set per D5.
2. Widgets honour them; builder grows a "Content" checkbox group and a theme
   picker; snippet + direct link + feed URL all carry the same params
   (regression-tested the way track filters now are).

### Wave E — revision breadth (F6, ~1 day, migration 0031)
1. `0031_revisions_entity_type.sql` per D8.
2. Record pre-edit snapshots in the contacts PUT (profile fields) and settings
   PUT; `ContentHistorySection` mounts on speaker detail and Settings.
3. Restore = normal PUT (self-snapshotting), same as submissions today.

## 3. Sequencing and eval payback

A → B → C, then D and E in either order. A and F7 are defect-class work and
should go out with the next deploy (with `migrate:remote` for 0026/0029 first).
B kills the standing root cause behind judged defects in four areas (duplicate
Priyas in public widgets, agenda, CRM, speaker-mgmt); C and F4 directly answer
two more judged items. Re-running the eval after Wave C should recover most of
speaker-crm (60.5%) and speaker-management (88.3%); D and E chase the
content-management and embed rubric tails.

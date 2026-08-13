# Workplan 15 — Findings from the 2026-08-12 fresh-eyes replay run

Status: **pending**. Source: sbek fresh-eyes replay run
`C:\dev\killmysaas-evals\runs\2026-08-12T16-35-32-YyM9iU` (replay of the
recorded 09-11-31 run against the post-b815e77/6e6f022 deployment, judge
claude-opus-5, fresh-eyes claude-haiku-4-5). Findings already covered by
`tests/spec-gap-audit-2026-08-12.md` (rating-sort direction, auto-schedule,
org-level CRM dashboard, the `agenda_published` blanket gate, duplicate-contact
remediation) are **excluded** — they are being addressed from that audit.
Two live checks were re-verified by hand today and are marked as such.

## ⚠ Read this first: evidence caveats

This run **replayed recorded browser actions** against the *current* deploy.
Replay diverges wherever the app now renders differently (that's often the
fix working!), and recorded observations were only admitted as evidence when
a fresh screenshot corroborated them. Consequences for whoever picks this up:

1. **Wave R items are NOT confirmed bugs.** Each was reported broken pre-fix,
   has a fix commit that claims to address it (b815e77 / 6e6f022), and was
   *re-reported* by this run — but replay mechanics can reproduce the old
   symptom against correct code (see each item's note). **Verify live before
   writing any code; the correct outcome for an item may be "already fixed,
   closed with evidence".** Record the verification either way.
2. Wave B/C items rest on fresh screenshots or were re-verified by hand
   today; treat them as real.

## Wave R — regression checks (verify first, fix only if live-reproduced)

| # | Claimed regression | Prior fix that should have covered it | How to verify live |
|---|---|---|---|
| R1 | **Draft-resume loads an empty form, autosave then destroys the stored draft, and the submitted record mixes old title with new abstract** (CFP majors). | b815e77 CFP-wizard domain | On `/submit/ai-engineer-sandbox-event/form…-0001` as a speaker with a saved draft: resume → do fields arrive populated? Change title+abstract → submit → both on the record? **Replay caveat:** if resume now populates correctly, the recorded action script (which never re-typed the title) submits with the draft title — reproducing the old symptom against fixed code. |
| R2 | **Edit page doesn't hydrate saved Track** (shows "Select…" while read-only view shows the value); saving would clear it. | b815e77 CFP-wizard domain | Portal → any submission with a track → Edit → is the Track select pre-selected? 1-minute check. |
| R3 | **Second message to the same recipient silently dropped** — "No messages were sent. Every recipient has a row…" yet no `message_log` row created. Reported dropped *twice* this run. | b815e77: idempotency key was `compose:<contact>:<contact>:v1` for every compose; fixed to key on bulk job id | Compose to the same contact twice from Workspace → Messages; count `message_log` rows (remote D1: `wrangler d1 execute … --remote` for certainty). |
| R4 | **Bulk send "Send to 3" → "1 message sent"**, one log row (CRM). | Same idempotency family as R3 | Send to a 3-recipient segment, then re-check the Messages log after ≥1 min: bulk sends drain via the sweep cron, so "1 sent" immediately after may be honest (`2 queued`). Three rows eventually = wording issue only (report "N sent, M queued" at confirm time); one row ever = real dedupe gap. |
| R5 | **Speaker's saved abstract edit not shown on detail after reload**, though dashboard shows "Updated Aug 12" timestamp. | b815e77 (portal edit persistence family) | Portal → edit an abstract → save → hard reload detail. If text IS current: the defect reduces to timestamp-updates-when-content-write-failed ordering, check what the failed write path touches. |
| R6 | **Embed builder shows no per-field visibility toggles / theming** — contradicts workplan 14 F3 (built per D5/D6: `data-*` token allowlist + `parsePageOptions` booleans). | 6e6f022 wave (embed toggles/theming) | Open `/app?v=embeds`: are the toggles/theme controls present? If yes, the eval judge missed them (possibly below the fold or behind a widget-type selection) — consider surfacing, not rebuilding. If absent, the wave didn't reach the builder UI. |

## Wave B — defects to fix (fresh evidence, not covered by the audit)

| # | Defect | Evidence | Notes |
|---|---|---|---|
| B1 | **Submission limit enforced one-late**: a form advertising "Submission limit: 1 per user" accepts one more duplicate (SESS-15 alongside SESS-10) and only then starts blocking. | Fresh confirmation screenshot (`ABS-S1/screenshots/008`), reproduced in both replay runs | Enforce the limit at submit time server-side (count existing non-draft submissions by contact for the form *before* insert), not only in the pre-render check. |
| B2 | **`/e/:slug/agenda.json` returns bare `{"error":"not_found"}` for an existing event whose agenda is merely unpublished** — indistinguishable from a bad slug, inconsistent with the HTML page's friendly message. | **Re-verified live today** (`curl /e/devflow-conf-2027/agenda.json`) | Return a structured `{"error":"not_published"}` (or 200 with `published:false`) for a valid slug. |
| B3 | **404 page links "Speaker portal" → `/portal`, which is itself a 404.** | **Re-verified live today** (`GET /portal` → 404) | Either make `/portal` a portal chooser/landing (list events for the session, or the sign-in card) or drop/re-point the link. |
| B4 | **Reviewer de-anonymization risk**: after submitting a scorecard, the reviewer's rationale is republished in a per-submission "Discussion" thread attributed by display name ("Rosalind Franklin · Reviewer"), with no visibility control observed. | Reviewer-flow observation, fresh run | Decide visibility policy: in blind/anonymized rounds, discussion entries derived from review rationale should be anonymized to other reviewers (organizers may still see names). Check what `submission_comments` exposes and to whom. |
| B5 | **Decision control easy to mis-target on organizer submission detail**: the agent operated a status dropdown offering "Not asked / Pending / Granted / Refused" (travel/visa-request vocabulary) believing it was accept/reject, and the intended acceptance never took effect. | Fresh run, CFP-S3 | Likely a labelling/proximity problem rather than a broken control: label the request-status widget with its subject ("Travel funding: …") and ensure the actual decision action is the visually primary control on the detail page. |

## Wave C — UX polish (fresh evidence, small)

| # | Item | Evidence / note |
|---|---|---|
| C1 | **Agenda builder empty-state contradiction**: zero sessions renders "Nothing here yet" beside "Every accepted session is scheduled · 0 unplaced · 0 conflicts" — reads as a *complete* agenda. Gate the reassuring copy on ≥1 accepted session. | `AIA-S2/screenshots/005,007` |
| C2 | **"Loading…" indistinguishable from empty** in workspace list panes (Submissions/Comments/Files). Use a skeleton/spinner distinct from the zero-state copy. | `AIA-S1/screenshots/003-004`, `CNT-S1/005-012` |
| C3 | **Dashboard re-render churn**: header cycles "updated just now / 5s ago / 10s ago", replacing DOM nodes continuously — plausible lost-focus source for users mid-form (and the likely cause of many eval stale-element failures). Render the age text without remounting subtrees (isolate the ticker), and/or pause polling while a form has focus. | `SPK-S3/images 33–40` |
| C4 | **CRM directory filters don't compose**: typing in Search resets the active Confirmation pill to "All" — last criterion wins silently. Make search and status filter independent query params. | Found identically in live + both replay runs |

## Out of scope for this plan

- Everything in `tests/spec-gap-audit-2026-08-12.md` (being addressed from there).
- Replay-state artifacts the judge could not distinguish from app behavior:
  all-empty public widgets, DevFlow KPI zeros / Files 0 / "Speakers 1 vs
  Participants 0", mid-flow portal session drop, Priya affiliation mismatch
  (uncorroborated recycled claim).
- Eval-harness bug, lives in `C:\dev\killmysaas-evals` not here: the judge
  emitted a defect row whose description and `where` are the literal string
  `"placeholder"` (ABS area) — structured-output schema/prompt fix in
  `judge.ts`.

## Suggested execution

Wave R first (it's mostly verification and may close half its items in an
hour — every closure de-risks the CFP area's score), then B1–B5, then C.
B2/B3 are one-liners; land them with Wave R's evidence commit. Nothing here
needs a migration.

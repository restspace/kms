# 15 — Winning moves: reading between the lines of the brief

Working notes on what the brief asks for implicitly, and where the remaining time buys the most.
Cross-checked against [01](01-requirements.md), [12](12-build-plan.md) and [13](13-open-questions.md)
so nothing here duplicates what is already built.

---

## 1. The tells

Four lines in the brief carry more weight than the numbered feature list.

| Line | What it actually means |
|---|---|
| *"an open source clone that YOU make (**and keep**)"* + *"we never have to pay for this closed source SaaS"* | The emotional core is **escape**, not features. Anything that lowers switching cost or lock-in outranks a seventh feature. |
| *"Tiebreaker goes to whoever has made **subjective judgment calls** for the product that we would actually use/buy"* | An explicit invitation to build unasked-for things. It is the only criterion where you beat a competent competitor shipping the same six features. |
| *"Bonus points for persistence/DB using Airtable — **because those are what we use on our team**"* | Not an architecture preference. It means "our team lives in spreadsheets and does not trust apps that trap data." D1-primary with a mirror (A13) is the right call; the underlying want is **portability**, which can be served better than by an Airtable adapter. |
| *"we do not want slow SaaS pls"* | A grievance about Sessionboard, not a requirement. Judges feel this in the first 30 seconds of clicking. |

And the strikethroughs are not "we don't want this" — they are "we assumed this was too much to
ask." Items #4 (AI-assisted review) and #9 (embeddable schedule) are struck *in a brief written by
the people who run AI Engineer*. Those are wants, de-scoped out of politeness.

---

## 2. Ranked moves

### Tier 1 — win conditions

**1. Sessionboard importer.**
Nobody asked; everybody needs it. They have live data in Sessionboard *today*, and a clone they
must re-key an event into is a demo, not a replacement. Map their CSV/XLSX export (or the linked
API) onto speakers, submissions, sessions and rooms. This is the single feature that converts
"nice clone" into "we could switch on Monday." FR-REV-8 already gives CSV session import — widen
it and name it *Import from Sessionboard*. Verified source formats in §4; design constraints in §5.

**2. Un-strike the AI review.**
A5 notes the evaluation schema already supports a machine reviewer, so this is additive. For this
audience the demo moment is large: dedupe near-identical abstracts, flag off-topic or slop
submissions (an AI conference CFP is largely LLM-generated pitches), suggest a track, draft the
rejection note. Non-negotiable design constraint: it **proposes, a human commits** — never an
auto-applied score. Getting that boundary visibly right is itself the judgment call they asked for.

**3. Make speed a visible artifact, not a claim.**
⌘K palette is priority C in FR-PLAT-3 — promote it. Keyboard-first navigation, instant tab
switches, and something honest on screen (p95 in the footer, a `/status` page with real numbers).
"This feels faster than Sessionboard" is the impression that survives to the evaluation call.

**4. One-click full export — and re-import of that same file.**
A zip of JSON + CSV + uploaded files that the importer accepts back. Roughly two hours, and it
*is* the brief's thesis: you keep it, nobody can hold it hostage. Say so in the README.

### Tier 2 — taste tiebreakers

**5. Clone last year's event.**
They run several events a year and Sessionboard almost certainly bills per event. Duplicate an
event with forms, tasks, email templates and evaluation plans carried over, plus speaker identity
persisting across events ("spoke at WF 2024"). A1 says the schema already supports it. Turns a
one-shot into a platform.

**6. Run-of-show / green room view.**
The last 48 hours before a conference is peak pain and Sessionboard is weak there: who has checked
in, who is on stage next, slides received y/n, swap a speaker into a slot and auto-notify everyone
affected. Unrequested, and instantly recognisable to anyone who has run an event.

**7. The struck embeddable schedule (#9).**
A single `<script>` embed plus a public JSON feed over the existing agenda. Two hours, and it
deletes a chore they repeat every year on the AI Engineer site.

**8. Sponsor / invited sessions.**
A4 dismissed sponsors, but sponsor-tier speaking slots are conference reality: they bypass review,
must not be scored like CFP talks, and still need tasks, comms and an agenda slot. A
`source: cfp | invited | sponsor` flag is small and reads unmistakably as "built by someone who has
actually run a conference."

**9. Close the loop on the dashboard.**
Brief #6 asks *who is outstanding*; the missing half is *acting* — escalating nags, waitlist
promotion on a dropout, reply-to a real human inbox, one speaker link that never expires. The
outbox exists; this is mostly UI.

### Explicitly skip

Payments (A3 is right), SSO, Airtable-primary persistence, WebSockets, the generic dashboard builder.

---

## 3. The cheapest high-leverage thing

A README section titled **"Judgment calls we made that you didn't ask for."** The tiebreaker
criterion is subjective and the evaluator is time-boxed, so telling them exactly where to look and
why each call was made is close to free and targets the stated deciding rule directly.
[13-open-questions.md](13-open-questions.md) is already 80% of that document, written in the wrong
register.

---

## 4. What Sessionboard actually exports (verified)

Confirmed against their knowledge base and public API docs, August 2026.

### CSV / XLSX export — the path that needs no permission

Every module has `Options → Export`, producing **CSV or XLSX**, for:

- **Sessions**
- **People / Contacts** (speakers, moderators, chairpersons)
- **Sponsors**
- **Exhibitors**

A separate **Reports** module produces Session, Contact, Group and **Evaluation Plan** reports as
CSV/XLSX — the evaluation plan report is where scoring data lives. Headshots have their own bulk
download function.

Two constraints that shape the design:

- **There is no fixed header set.** Exported columns are whatever the user had in their table view
  at the time. Fuzzy header auto-mapping plus manual override is mandatory, not a nicety.
- **File attachments export as publicly hosted URLs**, not embedded files. Slides and documents
  must be fetched from those URLs as a second pass, and the URLs may expire.

### Their import conventions — a free spec for the data's shape

Sessionboard's own import documentation states the conventions their data obeys, which tells us
how the exported values will be formatted:

| Convention | Value |
|---|---|
| Encoding | UTF-8 required |
| Max records | 1,000 per file |
| Multi-select | pipe-separated — `Convertible \| Two Door` |
| Session dates/times | `YYYY-MM-DD HH:mm` |
| Phone | `+1 (123)456-7891` |
| URLs | `https://sample-website.com` |
| Not importable | currency and file field types |
| Required — Contacts | First Name, Last Name |
| Required — Sessions | Status, Title |
| Dedupe keys | Email (contacts), Name (sponsors/exhibitors), **Session ID** (sessions) |
| Upsert trigger | a column `Update record if already exists` set to `TRUE` |

This hands us the `external_id` for free (Session ID for sessions, email for contacts) and
confirms the upsert-on-source-key design in §5.

**Consequence worth taking:** because their *import* format is documented, KMS should also
**export in Sessionboard-import shape**. A round trip out and back is the strongest possible
answer to lock-in, and it is roughly an hour on top of the exporter in move #4.

### Public API — the optional second source

`https://public-api.sessionboard.com` (EU: `public-api-eu`), token auth, OpenAPI published.
Relevant endpoints: `search-sessions`, `search-speakers`, `search-event-contacts`,
`search-sponsors`, `search-exhibitors`, `list-rooms` / `list-tracks` / `list-tags` /
`list-session-statuses`, and `list-fields` / `search-fields` which return **standard and custom
field definitions** for an event. Pagination defaults to 25, max 100; rate limited with 429 +
backoff expected. Requires a token from the organisers, so treat it as the richer optional path
and keep CSV/XLSX as the one that works unaided.

### Known gaps — be honest about these

- **No separate submissions/abstracts export.** Abstracts are sessions in an abstract composition
  state (`composition_status`), so they arrive through the sessions export.
- **Nothing exports onboarding tasks.** Task definitions and completion state are a
  rebuild-from-scratch item, not an import item. Say so rather than implying fidelity.

---

## 5. Making the importer survive real data

Real exports contain things the schema does not model: speakers with no email, two speakers sharing
one email, sessions with no room, Excel serial dates, CRLF, smart quotes, emoji, empty required
fields, and columns nobody has ever heard of. The way to win with an importer is not to parse
everything correctly — it is to **never lose data and never half-apply a change**.

**Ingest raw, promote strictly.** Two phases, two tables. Phase one writes every source row
verbatim into an `import_row` staging table with its original payload as JSON — this never fails
validation. Phase two maps and promotes rows into domain tables. A row that cannot be promoted
stays in staging marked `needs_attention` with a reason; the rest of the import proceeds.
Partial success is the contract, not the failure mode.

**Per-row, not per-file, atomicity.** One bad row must never abort 900 good ones. Stamp every
created record with the `import_batch_id` so the entire import can be undone in one click — that
undo is what makes a judge willing to press the button on their real data.

**Idempotent on a stable source key.** Keep the source system's ID as `external_id` and upsert on
it. They *will* run the import twice; the second run must update, not duplicate.

**Never discard unmapped columns.** Stash them in an `extra` JSON blob and surface them on the
record as "imported fields". Unmodelled data is preserved and visible rather than silently dropped,
which is the failure people actually resent.

**Dry-run preview with a diff, before anything is written.** Show *N to create, N to update, N
skipped and why*, with a column-mapping step that auto-guesses headers and allows override. The
preview is both the safety mechanism and the best thing in the demo — it shows the system being
honest about messy input rather than pretending.

**Degrade to draft, do not reject.** An imported record that violates an invariant should land in
a `needs review` state rather than bounce. A session with no room becomes an unscheduled session;
a speaker with no email becomes a contactless speaker who cannot be sent mail until fixed. Relax
constraints for imported rows specifically, not globally.

**Emit a report artifact.** A downloadable CSV listing every skipped row with its reason turns a
failed import into a to-do list. Pair it with a filtered admin view of the `needs_attention` rows
so fixing them happens in-app.

**Test against adversarial fixtures.** Ask in Discord for a sanitised Sessionboard export — that
single file de-risks this more than any amount of defensive code. Alongside it, keep fixtures for
the usual horrors: empty file, headers only, duplicate emails, mixed date formats, 10k rows,
UTF-8 BOM, quoted commas, missing columns.

**Scope the promise out loud.** Do not claim full fidelity. Claim: *people and submissions import
cleanly; schedule and files are best-effort; everything unmapped is preserved and reviewable.*
Under-promising here reads as competence, not weakness.

**Keep the demo off the critical path.** Demo the import against a known fixture. Keep the messy
file as the follow-up beat — "and here is what happens with real data" — where the preview, the
report and the one-click undo are the point being made.

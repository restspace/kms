# 04 — CFP: Form Builder & Public Submission

Covers brief requirement **#1 — "Custom call-for-speakers submission forms with conditional
logic and category-based routing"**, plus the public submission experience that feeds the portal.

---

## 1. Forms list (`/app/e/:event/forms`)

Reference: screenshot 5.

- Header "Submission Forms — Collect abstract, session and participant information for your event".
- **Add ▾** → `Create Form` | `Copy from…` (clone an existing form, including questions and rules).
- Search box; tabs **All / Open / Closed** with counts; sort control (default "Most Pending").
- Each row: submission-count badge, internal name, status chip (`Open` dark / `Closed` grey),
  collection-type chips (`Abstracts & Participants`), a version chip, and
  `N submissions · M drafts · Closes <date>` with the created date right-aligned.
- Row overflow menu: Edit, View public form, Copy link, Duplicate, Close/Reopen, Delete.

---

## 2. Form builder wizard (`/app/e/:event/forms/:id/edit`)

A left rail of ordered steps with completion ticks; content pane on the right; sticky header with
**View Form**, **Copy Link**, **Save**; footer **Back** / **Next** (final step shows **Save**).

| # | Step | Subtitle |
|---|---|---|
| 1 | Submission Setup | Submission type and participants |
| 2 | Welcome Screen | Welcome message and terms |
| 3 | Abstract Information | Session or abstract questions |
| 4 | Participant Information | Participant and contact fields |
| 5 | ~~Payments & Fees~~ | **Omit entirely — marked NOT NEEDED** |
| 6 | Form Settings | Deadlines, limits, and success page |
| 7 | Notifications | Admin alerts and email templates |

> Renumber to 1–6 with Payments removed. Do not build a disabled placeholder.

### 2.1 Submission Setup
"What kind of submissions do you want to collect?" — two large selectable cards:

- **Abstracts** — "Collect abstract submissions for review before sessions are finalized."
- **Sessions** — "Collect full session proposals with details for your program."

Below, a toggle row: **Participants** — "Include a step to collect speaker and participant
contact information." Note: "You can adjust these choices later by editing this form."

### 2.2 Welcome Screen
- `Internal Form Name` * (≤255, counter shown)
- `External Form Title` * (≤255, counter)
- `Page Heading` * — **15 character max**
- `Welcome Message` — rich-text editor with a **Show message** toggle.
  Editor toolbar: bold, italic, underline, superscript, subscript, link, bullet list, numbered
  list, outdent, indent, align left/center/right, image, overflow.

The reference welcome copy shows what organisers actually write — headings, paragraphs, a track
list, links to Speaker Agreement / FAQs / Tips, and a Dates-and-Deadlines list. The renderer must
handle h1–h3, p, ul/ol, links, bold/italic and images.

### 2.3 Abstract Information
- `Section Title` * (counter), `Page Heading` * (≤15), `Description & Instructions` * (rich text)
- **Form Questions** card with an **+ Add Field** button.

Each question row shows: drag handle, label, required asterisk, `Locked` chip for system fields,
type + constraint chips (`Text` `Max 255 chars`, `Wysiwyg` `Max 5,000 chars`, `Dropdown`), a
**Required** toggle, and an overflow menu (Edit, Duplicate, Conditional logic, Remove).

Default question set to seed:

| Label | Type | Constraint | Required | Locked |
|---|---|---|---|---|
| Title | Text | 255 | yes | yes |
| Description | Wysiwyg | 5000 | yes | no |
| Format | Dropdown | — | yes | no |
| Tags | Dropdown (multi) | — | yes | no |
| Track | Dropdown | — | yes | no |
| Level | Dropdown | — | no | no |
| Language | Dropdown | — | no | no |
| Capacity | Number | — | no | no |
| CEU Credits | Number | — | no | no |
| Client Session ID | Text | — | no | no |

**+ Add Field** opens a picker with two entries at the top — `Add Section Element ›` and
`Create Field` — followed by a searchable list of library fields showing their type chip
(`text`, `wysiwyg`, `dropdown`). Section elements are non-input blocks: heading, paragraph, divider.

### 2.4 Participant Information
- Section title, page heading, rich-text instructions.
- **Participant roles** panel: "Choose which roles submitters can add. Optionally set minimum and
  maximum counts per role, and overall limits across all roles."
  Each role row: checkbox, icon, name, description, `Min` and `Max` numeric inputs.
  Seed with `Speaker`; allow `Co-speaker`, `Moderator`, `Panelist`.
- **Form Questions** for the participant section — defaults: First Name (locked, req),
  Last Name (locked, req), Email (locked, req, type Email), Mobile Phone (Phone, optional),
  Biography (Wysiwyg 5000, optional). Headshot (File) available to add.
- Note shown to admins: "Collect information for participants and the primary contact for this submission."

### 2.5 Form Settings
- **Deadlines → Close Date** — *"If set, form and submissions will close after specified date."*
  Helper: *"Set a close date to enable draft reminder emails."* Marked **"kinda impt"**.
- **Submission capacity**
  - `Set Submission Limit` toggle — "Limit how many sessions one user may have for this form.
    Includes saved drafts and submitted sessions." Chip shows `Event max: 3` — "Applies when no
    form-level limit is set."
  - `Allow multiple draft submissions` toggle.
- **After submission** — marked **"make sure this works"**
  - `Auto-redirect to speaker portal` toggle — "After 10 seconds on the confirmation page.
    If off, submitters use Continue to portal."
  - `Customize the success page message` rich text — "Shown on the public confirmation page after submit."
- **Validation rules → Cross-field character limits** — "Cap the combined length of several text
  fields (for example a printed program block). Submitters see a live combined counter;
  speaker-field rules apply to each participant." **+ Add rule**.

### 2.6 Notifications
- "What admins should be notified when a **new submission is received**?" — contact chips picker. *(nice to have)*
- "What admins should be notified when an **existing submission is updated**?" *(nice to have)*
- **Submitter notifications** (1 template) → **Submission Confirmation** — "Email sent to the
  submitter after a successful submission" — toggle + **Customize**. **Marked "must have".**
- **Admin notifications** (2 templates) — expandable.

---

## 3. Conditional logic

Reachable from a question's overflow menu → *Conditional logic*.

**Editor UX**
```
Show this question when  [ all ▾ ]  of the following are true:
  [ Track  ▾ ]  [ is any of ▾ ]  [ Agents ×  Evals × ]        [ − ]
  [ Format ▾ ]  [ equals     ▾ ]  [ Workshop ▾ ]              [ − ]
                                                       [ + Add condition ]
```

**Rules**
- Only questions that appear **earlier in the form order** may be referenced (prevents cycles).
- Evaluation is live on the public form; a hidden question is cleared and never validated.
- The server re-evaluates on submit against the stored definition; answers to questions that
  should be hidden are discarded, and hidden required questions do not block submission.
- Rules survive question reordering by referencing question IDs, not positions.

**Worked example** — the AIE case: a *Workshop* format reveals `Room setup requirements`,
`Max attendees` and `Prerequisites`; a *Panel* format reveals `Proposed panelists`.

---

## 4. Category-based routing

Configured per form under a **Routing** panel on the Abstract Information step (or its own
sub-step). Rules run in order after a submission is created.

| Trigger | Action |
|---|---|
| Answer to a chosen question (typically `Track` or `Format`) matches a condition | Set track; add tags; assign to an evaluation plan / reviewer group; notify specific admins; set initial status |

```jsonc
{
  "rules": [
    { "when": {"question": "track", "op": "equals", "value": "Agents"},
      "then": {"assign_evaluation_plan_id": "plan_agents", "add_tag_ids": ["ai"], "notify_contact_ids": ["lead_agents"]}},
    { "when": {"question": "format", "op": "equals", "value": "Workshop"},
      "then": {"assign_evaluation_plan_id": "plan_workshops", "set_track_id": "trk_workshops"}}
  ],
  "fallback": {"assign_evaluation_plan_id": "plan_general"}
}
```

Every applied rule is written to the submission's history so an organiser can see *why* a
submission landed with a given reviewer.

---

## 5. Public submission flow

URL: `/submit/<event-slug>/<form-id>` (reference: `appv2.sessionboard.com/submit/ai-engineer-sandbox-event/<uuid>`).

**Stepper:** `1 Welcome! → 2 Account → 3 Submission → 4 Participant → 5 Review`

### Step 1 — Welcome
Info banner above the content:
```
Form submissions will be accepted until September 15 at 11:59 PM PDT.
Submission Limit: 3 submissions per user
```
Then the external form title as an h1 and the rendered welcome message.

### Step 2 — Account
Email input → magic link. If the address already has a portal account, the link resumes their
session; otherwise a contact is created. A "why am I signing in?" note explains the portal.

### Step 3 — Submission
Renders abstract questions with live conditional logic, per-field character counters, inline
validation, and autosave to draft every 10 s.

### Step 4 — Participant
Participant cards honouring role min/max and the overall cap. The signed-in submitter is
pre-filled as participant 1 and marked primary contact. Each card collects the participant
question set; bios and headshots can be deferred to the portal.

### Step 5 — Review
Read-only summary grouped by section with **Edit** links. Terms acceptance checkbox if configured.
**Submit** is disabled until all visible required questions pass.

### After submit
1. Persist submission (`status = pending`), run routing rules, allocate a `code` (`SESS-4`).
2. Enqueue the **Submission Confirmation** email (must-have).
3. Render the customised success page. The reference copy:
   > You will receive a confirmation email shortly with a link to your speaker portal. We will
   > review sessions over the next few weeks and then notify you regarding your status.
   > Next, you will be logged into your speaker portal where you can see if there are any tasks
   > to complete. If you would like to submit another session, please **click here** to return
   > to the submission form.
4. If `auto_redirect_to_portal`, redirect after 10 s with a visible countdown and a
   "Continue to portal" button as the manual path.

### Edge cases
| Case | Behaviour |
|---|---|
| Form closed | Replace the wizard with a closed notice showing the close date and a link to the portal |
| Over submission limit | Block at step 3 with "You have reached the limit of N submissions for this form" and a link to existing submissions |
| Draft resumed after close | Read-only; explain the deadline has passed |
| Same email, different capitalisation | Normalise to lowercase; one contact |
| Back-navigation | State preserved; the stepper allows returning to completed steps only |

---

## 6. Acceptance tests

1. Build a form with a conditional question and a routing rule; publish; submit as a speaker;
   confirm the conditional question appears only for the right answer.
2. Submitting with the routing answer assigns the correct evaluation plan and tag.
3. Setting a close date in the past closes the form for both new and existing submissions.
4. The confirmation email arrives with a working portal link.
5. Auto-redirect lands the submitter on their portal home already authenticated.
6. A form with a submission limit of 1 blocks the second submission, drafts included.

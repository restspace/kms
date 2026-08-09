# 05 — Speaker Portal

Covers brief requirement **#2 — "Self-service speaker portal for bios, headshots, slides, and
supporting documents"** and the speaker-facing half of requirement #6 (outstanding onboarding tasks).

Base URL: `/portal/<event-slug>` — reference screenshots 17, 18, 25–31.

---

## 1. Access

- Passwordless. Entry points: the link in the submission-confirmation email, the auto-redirect
  after submitting, or `/portal/<event-slug>/login` with an email + magic link.
- Session cookie lasts 7 days, sliding. Logging out clears it.
- The header shows the speaker's avatar and name with a menu: **Profile**, *(admins only)*
  **Back to Admin Mode**, **Logout**.
- Admins reach the portal through **View Portal** in the admin header; an impersonation banner
  is shown while active.

---

## 2. Navigation

A centred pill nav under the page title: **Home · Submissions · Profile · Tasks**.
Mobile: the same four items as a bottom bar or a wrapped pill row.

---

## 3. Home

Title "Home". Three cards.

### My Submissions (count in the header, "View All" link)
One card per submission:
```
SESS-4 — sd
Featured Keynote
● Accepted
```
- Line 1: `code — title`
- Line 2: format
- Line 3: status with a coloured icon — Accepted (green check), Pending (amber ring),
  Declined (red), Draft (grey), Withdrawn (slate)
- Clicking opens the submission detail.

### My Profile
Avatar/initials, name, email, **View more** → Profile page.

### Tasks
- Tabs: **All**, **My Tasks (n)**, **Submissions (n)**; a **Filter ▾** control; **Open All / Collapse All**.
- Two groups, each with an info tooltip:
  - **Submission Tasks** — tasks tied to a specific submission (e.g. upload slides for SESS-4).
    Empty state: "No submission tasks found."
  - **My Tasks** — tasks tied to the person (e.g. hotel booking, headshot).
    Empty state: "No tasks found."
- Each task row: title, due date, status pill, and a primary action button.
- Overdue tasks are visually distinct (red due date + badge).

---

## 4. Submissions

- List of the speaker's submissions with code, title, form name, status, submitted date,
  and last-updated.
- Detail view shows every answered question grouped by section, the participant list, and any
  attached files.
- **Edit** (`/portal/:slug/submissions/:id/edit`) is available to the submitter and to every
  participant, for as long as the submission is **not** `withdrawn` or `declined` — acceptance does
  not lock a proposal. The form is rendered from the submission form's *abstract* questions and
  validated with the same shared validators as the public wizard; failures re-render the page with
  the speaker's input preserved. Withdrawn/declined submissions show a read-only explanation
  instead ("Editing closed").
- Saving after a decision has been made is allowed, and the organisers listed in the form's
  `notify_admins_on_update` are emailed exactly one `submission_updated_admin` notice per save.
- **Withdraw** action with a confirmation dialog; sets `status = withdrawn` and notifies admins.

---

## 5. Profile — *"update your own bio data"*

Header: avatar, name, email. Single tab **Profile Info**. Two columns.

### General
| Field | Control |
|---|---|
| Biography | Rich text, 5000-char counter shown as `0 / 5,000 characters`. Toolbar: bold, italic, underline, bullet list, numbered list, align left/center/right, link, clear formatting |
| Salutation | Text |
| First Name / Last Name | Text, required |
| Honorific | Text |
| Pronouns | Select (they/them, she/her, he/him, prefer not to say, self-describe) |
| Gender | Select, optional, includes prefer-not-to-say |
| Headshot | Image upload with crop; shows recommended dimensions and max size |
| Company / Job title | Text *(optional additions)* |

### My Links
`LinkedIn URL`, `X (Twitter) URL`, `Facebook URL`, `Website` — URL-validated, all optional.

Saving is explicit (a Save button with a dirty-state indicator), with inline validation and a
success toast. Profile completeness drives the dashboard nudge
*"N accepted speakers are missing a bio or headshot"* — the definition of "complete" is
**biography non-empty AND headshot present**.

---

## 6. Tasks

Tasks are created by admins (see §8) and assigned to a contact and optionally a submission.

| Task action type | Speaker experience |
|---|---|
| `file_upload` | Drop zone / file picker, allowed types and max size stated, upload progress, replace-file support. When the task is backed by a **File Request**, that request's `allowed_types` and `max_size_mb` are the effective policy (and are what the portal copy states); otherwise the generic portal limits apply. Uploads are checked for size and for magic-number/declared-type agreement — malware scanning of stored bytes is deliberately out of scope for now |
| `portal_form` | Renders the admin-defined portal form inline; submitting marks the task complete |
| `acknowledge` | Read the instructions, tick "I have read and agree", confirm |
| `external_link` | Button opening the URL, then a "Mark as done" confirmation |

Task states: `Not started → In progress → Complete`. Completing a task:
1. Records `completed_at` and any response/file.
2. Decrements the outstanding-task counters on the dashboard within one refresh cycle.
3. Optionally sends a confirmation email if the task's form has one enabled.

Reminders are sent per the task's `reminder_offsets_days` (see [08](08-communications.md)).

---

## 7. Slides & supporting documents

Two routes, both required by the brief's "slides and supporting documents":

1. **A `file_upload` task** — the normal path ("Presentation Upload"). The file is attached to the
   task assignment and to the submission, so it appears in the admin's submission detail and in
   the *Download files bundle* export.
2. **A File Request** — a standalone ask not tied to a submission or contact record. The reference
   product is explicit: *"Files are stored, not attached — uploaded files live on this File Request
   and can be downloaded or exported. They are not attached to the contact, group, or session record."*
   Use for contracts, W-9s, travel forms.

Accepted types and limits are per [03 §8](03-architecture.md).

---

## 8. Admin-side configuration of portal content

These live in the admin app under **Portals** but define what the speaker sees.

### Portals → Tasks (`/app/e/:event/portal/tasks`)
- Header "Tasks — Create tasks that can be assigned to your portals".
- **Add ▾** → `Add Task` | `Copy from…`
- Tabs: **All Tasks / Contact Tasks / Group Tasks / Submission Tasks** with counts.
- Cards show title, an assignment-mode chip (`Manual` / `Automatic`), the description, and the
  target type with an icon (`Contact`, `Session`).
- Task editor fields: title, description (rich text), target type, assignment mode and trigger
  (`on accept`, `on schedule`, none), action type + linked portal form or file request, due date,
  reminder offsets, required flag.

### Portals → Forms (`/app/e/:event/portal/forms`)
- Header "Forms — Create forms that can be assigned to your portals to collect information".
- Tabs **All / Contact Forms / Group Forms / Submission Forms**.
- Three-step editor: **Form Setup** (name, title, type: Contacts / Groups / Submissions) →
  **Form Questions** (same builder as the CFP: section title, instructions, drag-ordered
  questions, Add Section Element / Create Field / library picker, required + lock toggles) →
  **Settings** (Send Confirmation Email toggle with a rich-text body, deadlines, login requirement).
- Editor header actions: **Duplicate**, **Delete**, **Save**.

### Portals → File Requests (`/app/e/:event/portal/file-requests`)
- Header "File Requests — Collect files (e.g. documents, contracts) from your portals."
- Tabs **All / Contact / Group / Submission Requests**.
- Create dialog: Title (e.g. "Upload Presentation Slides"), Type (Contacts / Groups / Submissions),
  rich-text Instructions, allowed types, size limit, due date.

### Portals → Resources
Out of scope (struck through in the brief).

---

## 9. Empty & error states

| State | Copy |
|---|---|
| No submissions | "You have not submitted anything yet." + link to the open CFP form |
| No tasks | "No tasks found." / "No submission tasks found." |
| Expired magic link | "That link has expired. Enter your email to get a new one." |
| Wrong event | Redirect to the event chooser if the contact belongs to several events |
| Upload failure | Inline error with retry, file preserved in the picker |

---

## 10. Acceptance tests

1. A brand-new submitter reaches the portal from the confirmation email without typing a password.
2. Editing the biography and uploading a headshot clears the "missing bio or headshot" dashboard nudge.
3. A task assigned by an admin appears in the portal within one page load and its completion
   decrements *Outstanding speaker tasks* on the dashboard.
4. A `portal_form` task renders every question type and stores the response against the contact.
5. A file uploaded through a submission task appears in the admin's submission detail and in the
   downloaded files bundle.
6. The portal is fully usable at 375 px width.

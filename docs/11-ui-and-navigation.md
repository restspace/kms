# 11 — UI, Navigation & Design Direction

The brief is explicit: *"Cloning the exact design is not a requirement."* This document records
the **information architecture** worth copying (it reflects how organisers actually work) and
sets a deliberate visual direction of our own.

---

## 1. Admin information architecture

The reference sidebar, reduced to the in-scope modules:

```
[Event switcher]  AI.Engineer Sandbox Event – NYC · Oct 12–14, 2026

Dashboard

Program ▾
  Overview
  SUBMISSIONS
    View All
    Abstracts
    Sessions
    Files
  COLLECT & REVIEW
    Forms
    Evaluation
    Agenda
    ~~Invoices~~            (out of scope)
    Site
  PORTALS
    Portals
    Tasks
    Forms
    File Requests
    ~~Resources~~           (out of scope)
    Files
  CONFIGURE
    Settings

CRM            (contacts/speakers only)
~~Marketing~~  (out of scope)
CMS ▾          (Embeds — optional)
Reports
~~Studio~~     (out of scope)
History        (audit log — could)

Event Team
Preview
Settings
```

**Recommended simplification.** The reference has four separate "Forms" and three separate
"Files" entries in one sidebar, which is genuinely confusing. Collapse the record-keeping
core into a single **tab workspace** (see §3 and [12 §0](12-build-plan.md)) and keep a slim
sidebar for the bespoke surfaces:

```
Dashboard
Workspace        (tab workspace: Speakers | Submissions | Tasks | Messages* | Files*)
  Speakers         (workspace tabs are listed indented under Workspace;
  Submissions       clicking one opens the workspace on that tab)
  Tasks
  Messages
Forms            (tabs: Call for papers | Portal forms | File requests)
Evaluation
Agenda
Settings         (Event · Library · Email · Portal · Team · API)
```

**Events scope the Workspace as a *filter*, not a route.** The sidebar's event
dropdown is the control surface for a global event filter: "All events" shows every
event the signed-in staff member can access aggregated in the workspace tabs (each
row carries an Event column), and picking one event both narrows the workspace and
sets the *current event* for the per-event surfaces (Dashboard, Forms, Evaluation,
Agenda, Settings) — without a page reload. FR-EVT-5's "event switcher" is therefore
an event *filter*; the workspace tab-header row shows the active global-filter
anchor and the event chip. A "+ New event" affordance next to the dropdown opens
the Create Event dialog (FR-EVT-1/2).

*\* as time allows — see the cut list in [12 §1](12-build-plan.md).*

The workspace replaces the separate Submissions/Speakers/Tasks/Files sidebar entries and
their per-resource detail pages: entity list tabs sit side by side, records open as detail/
create/edit tabs next to their list, and a **global anchor filter** (select a row, make it
the filter) narrows every related tab to that record. This is exactly the kind of
"subjective judgment call for a product we'd actually use" the tiebreaker rewards — record
the reasoning in the README.

### Top bar
Global search / command palette (⌘K, "Find or ask") · **View Portal** · notifications ·
help · account menu.

### Settings hub
Card grid grouped as **Event setup** (Event Details, Record Settings, Portals, Submission Forms),
**Library** (Fields, Tags, Personas), **Communications** (Email Templates, Email Themes),
**Configuration** (Integrations, API tokens, Webhooks).

---

## 2. Route map

The admin SPA lives at `/app` and encodes its state in **query parameters** (the
event is a filter dimension, not a path segment — see §1). `pushState` is used for
navigation intents (view, tab, record, form), `replaceState` for parameter tweaks
(filter, search, agenda day/mode, builder step); Back/refresh/deep links restore
the full state, including opening a record's detail tab.

| URL | Screen |
|---|---|
| `/app?v=dashboard` | Dashboard (default view) |
| `/app?v=workspace&ev=all\|:event&tab=:key&rec=:id&q=:text&flt=:b64` | Tab workspace — event filter, active tab, selected record, search, stable filters |
| `/app?v=forms` · `&form=:id&fstep=:step` | Forms list / form builder wizard |
| `/app?v=evaluation` | Plans + criteria |
| `/app?v=review` | Reviewer workspace |
| `/app?v=agenda&mode=:view&day=YYYY-MM-DD` | Agenda (list \| day \| week \| rooms \| conflicts) |
| `/app?v=settings` | Settings hub |
| `/submit/:slug/:formId` | Public CFP wizard |
| `/portal/:slug` | Speaker portal (home/submissions/profile/tasks) |
| `/portal/:slug/submissions/:id/edit` | Speaker edits a submission (allowed unless withdrawn/declined) |
| `/e/:slug/agenda.json` | Public agenda JSON (404 until the agenda is published) |

Known deferred surfaces (recorded gaps, not regressions): portal-form and
file-request authoring UI, reviewer skip/shortcuts/autosave/anonymisation
controls, forms-list search/copy-from, track/room/tag CRUD, admin→speaker portal
impersonation entry point, a public agenda *page* (only the JSON feed exists),
`/embed/:token`, task-definition edit/delete in the grid, and cross-event export
(exports remain per-event). Auto-creating a session on acceptance is likewise
unbuilt and unspecified.

---

## 3. Core interaction patterns

### The tab workspace (Speakers, Submissions, Tasks, Messages, Files)
One `DataTabManager` instance configured per entity via `TabConfig`
(`apps/admin/src/components/`, ported from the atelyr codebase):

- **List tabs** with live row counts, virtualised infinite scroll, single-key sort,
  per-tab filter chips (status, search), inline cell edit, and checklist selection
  feeding a bulk-action bar.
- **Detail / create / edit child tabs** opened from rows (double-click, context menu,
  "+"), inserted beside their parent list, with unsaved-change guarding. Simple entities
  use schema-driven forms (`RecordForm`); complex ones supply custom components.
- **Global anchor filter** — shift-click a row or right-click → *Make global filter*;
  every other tab narrows to records related to the anchor via per-tab field maps,
  with join-table relations (participants, task assignments) resolved server-side.
  The source tab shows a filter dot; Ctrl+click adds additional anchors (AND).
  Ambiguous relation paths are always named ("Submitted" vs "Speaking on").

Deliberately dropped from the original grid spec (not supported by the components, not
needed for the deadline): saved views, column show/hide + width persistence, multi-key
sort, page-number pagination. CSV/XLSX export moves to the API, offered from the tabs.

### The form builder (used by CFP forms and portal forms)
Left step rail with completion state, right content pane, sticky primary actions, drag-ordered
question list, field picker with library search plus "create field", per-question settings popover
(required, help text, character limit, conditional logic).

### The wizard (used by the public CFP)
Numbered stepper, per-step validation, autosave to draft, back-navigation to completed steps only.

### The calendar (agenda)
Time grid with room/track lanes, drag/drop/resize, conflict badges, an unscheduled tray, and a
keyboard-accessible "Move session" dialog.

---

## 4. Design direction

Deliberately **not** a Sessionboard clone. Target: a fast, dense, calm operations tool.

| Token | Value |
|---|---|
| Type | One family (Inter / system-ui) at 14 px base, 13 px in grids; tabular numerals for counts |
| Density | Compact by default; 32 px grid rows, 8 px spacing scale |
| Colour | Neutral greys for chrome; one accent for primary actions; status colours reserved **only** for status (green accepted, yellow pending, amber queue, red declined, slate withdrawn, grey draft) |
| Elevation | Flat; 1 px borders instead of shadows, except overlays |
| Motion | ≤150 ms, only for state changes that need explanation (drag drop, toast, drawer) |
| Dark mode | Supported via CSS custom properties; both themes defined explicitly |

Status must never be conveyed by colour alone — every chip carries its label, and icons
accompany colour in the portal.

### Empty states
Every list has a purposeful empty state with one action: "No forms yet — Create a form to collect
information from participants", "Nothing here yet — Sessions will appear here in list view",
"No file requests yet", "No submission tasks found".

### Loading
Skeleton rows for grids, optimistic updates for drag/drop and toggles, inline spinners never
larger than the control they replace. No full-page spinners after first paint.

---

## 5. Responsive behaviour

| Surface | Mobile |
|---|---|
| Public CFP | First-class. Single column, sticky step header, large tap targets, native file picker |
| Speaker portal | First-class. Cards stack; the four nav items become a bottom bar |
| Public agenda / embeds | First-class. Day-by-day list with track filters |
| Admin workspace | Usable — DataList's built-in card layout below 640 px; the tab strip becomes a dropdown below 768 px |
| Agenda editor | Desktop-first; mobile gets read-only plus the "Move session" dialog |

---

## 6. Accessibility checklist

- All interactive elements reachable and operable by keyboard, with a visible focus ring.
- Drag-and-drop has the equivalent dialog-based path (`M` → Move session).
- Form controls have persistent labels, not placeholder-only labelling.
- Errors are announced (`aria-live="polite"`) and linked to their field.
- Colour contrast ≥ 4.5:1 for text, ≥ 3:1 for UI boundaries, in both themes.
- Rich-text editors expose a semantic toolbar with `aria-pressed` state.
- Modals and drawers trap focus and restore it on close.
- `prefers-reduced-motion` disables non-essential animation.

---

## 7. Copy guidelines

Plain, specific, active. Say what will happen ("Form and submissions close after this date"),
not what the feature is called. Dates always carry the timezone abbreviation. Counts are always
paired with their noun ("3 submissions awaiting a decision"). Destructive actions name the
object in the confirmation ("Delete Session Submission Form #4?").

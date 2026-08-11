# 16 — Mobile / responsive plan

Executes [15 §6](15-winning-moves.md) ("Mobile / responsive — scope and the line") against the code
that exists today. Layout only: no behaviour, schema, route or business-logic changes. The
run-of-show / green-room view listed in Tier B is not built and is out of scope here.

Verification widths: **390px** (iPhone-class, the target) and **768px** (tablet sanity check).
Desktop reference width is **1280px** — nothing in this plan may change what renders at ≥1080px
except where item 1 says so explicitly.

## Decisions taken before implementation

Four points where investigation contradicted §6; these are settled, not open:

1. **The admin shell is the real blocker.** `apps/admin/src/shell.css:10` pins
   `.shell-sidebar { flex: 0 0 184px }` with no media query, leaving a 206px content pane at 390px.
   §6 assumed Tier B was near-free because `DataList` already has mobile rows; it is not. This is
   item 9 and it is the bulk of the risk.
2. **Breakpoint "tokens" cannot be CSS custom properties.** Custom properties are invalid in a
   `@media` prelude and there is no PostCSS / `@custom-media` step in either Vite config. The
   tokens are a documented comment block in `tokens.css` plus TS constants in the hand-written
   `packages/theme/src/index.ts`; CSS literals stay literal.
3. **The workspace is not refused wholesale.** docs/11 §5 says the admin workspace should stay
   usable on mobile via DataList card rows and the tab dropdown, and that is already built for all
   six tabs. Refusing it would delete working functionality. Only the bulk-action bar and the
   global-anchor chip are hidden below compact — consistent with the §6 rule, since those are
   "arrange many records" affordances while list + detail is "act on one record". **Approved.**
4. **The dashboard's 900px breakpoint folds into 768 + 1080.** This changes the 900–1080 band from
   3 columns to 2 — the only sub-1080 desktop change in the plan, and an improvement rather than a
   regression. **Approved, subject to a 1280px before/after screenshot.**

Also noted: Tier A's "add-to-calendar" has **no UI surface** to improve. ICS exists as an emailed
attachment (`scheduleMail.ts` → `mailer.ts`) and as the public agenda's `.ag-ics` link. It reduces
to "the public agenda ICS link works on a phone", which it already does. Dropped from scope.

## 0. Current state (survey)

| Surface | File(s) | State at 390px |
|---|---|---|
| Speaker portal (all four sections) | `apps/api/src/routes/portal.ts` (`PORTAL_CSS`, l.51–128) | **Good.** Fluid `.wrap` (max-width 880), `.grid2` collapses at 640, inputs `width:100%` from `baseCss`. One defect: `dl.detail` is a hard `150px 1fr` grid. |
| Magic-link login / auth / error pages | `apps/api/src/html.ts` (`CSS`, `page()`) | **Good.** `main.card` is `width:100%;max-width:640px`. `body` padding `3rem 1rem` is heavy; `table` can overflow on listing pages that reuse `page()`. |
| Public CFP wizard | `packages/ui/src/SubmitPage.tsx` (`wizardCss`, l.1018–1078) | **Good.** One defect: `.sb-review > div` is `11rem 1fr`. Tap targets below 44px. |
| Public event pages shell | `packages/ui/src/Page.tsx`, `EventShell.tsx` | **Good.** `main{padding:4rem 1.5rem}` wasteful at 390 but not broken; nav wraps. |
| Sessions / Speakers / Gallery / Schedule widgets | `packages/ui/src/widgets/*.tsx` | **Good, untested.** `auto-fill minmax()` grids and flex-wrap toolbars collapse correctly. |
| Public agenda grid | `packages/ui/src/widgets/AgendaWidget.tsx` | **Acceptable.** `.ag-scroll` gives horizontal scroll with a sticky gutter; has a 640 query. No scroll affordance. |
| Admin shell chrome | `apps/admin/src/shell.css` l.4–17 | **Broken.** `.shell-sidebar { flex: 0 0 184px }`, **no media query**. Breaks every admin screen. |
| Workspace lists | `DataList.tsx` / `.css`, `DataTabManager.tsx` / `.css` | **Already mobile-aware** — JS card rows below 640, tab strip → dropdown below 768, `mobileRow` / `mobileHidden` configured for all six tabs. Blocked only by the shell. |
| Dashboard | `apps/admin/src/dashboard/dashboard.css` | **Partly.** `.db-grid` collapses at 900; header/KPIs/bar-rows fluid. Blocked by the shell. |
| Reviewer workspace | `apps/admin/src/workspace/review.css` l.397–431 | **Broken.** `.review-queue { flex: 0 0 300px }`, no media query. |
| Agenda editor | `apps/admin/src/agenda/*` | **Broken by design** (Tier C). List mode salvageable. |
| Form builder | `apps/admin/src/forms/forms.css` l.156–215 | **Broken by design** (Tier C). `.builder-rail { flex: 0 0 200px }`. |
| Settings | `apps/admin/src/settings/settings.css` | Fluid `.settings-shell`; Tier C by policy, not breakage. |
| Import wizard | `apps/admin/src/workspace/import.css` | Column mapping is a two-column grid in a `min(640px,100%)` dialog. Tier C. |
| Dialogs | `apps/admin/src/components/dialogs.css` | **Good.** `width: min(Npx, 100%)`, internal scroll. |

Viewport meta is present on every entry point — §6's claim holds.

### Breakpoints in use

There are **eight**, not six: the six CSS values plus two in JS.

| Value | Where | Disposition |
|---|---|---|
| 560 | `settings.css:53` (`.settings-rt-columns`) | → **compact (640)** |
| 640 | `DataList.css:399`, `portal.ts:72`, `AgendaWidget.tsx:520` | **compact** (canonical) |
| 640 (JS) | `DataList.tsx:520` `DEFAULT_MOBILE_BREAKPOINT_WIDTH`, `isViewportMobile` uses `<` | **compact**; off-by-one, see item 1 |
| 720 | `DataTabManager.css:846` (`.data-tab-header-trailing`) | → **medium (768)** |
| 768 | `DataTabManager.css:654` (tab strip → dropdown) | **medium** (canonical) |
| 768 (JS) | `DataTabManager.tsx:1213,1228` `matchMedia('(max-width: 768px)')` | **medium** |
| 900 | `dashboard.css:246` (`.db-grid` 3→1) | → **medium (768)** + new 2-col step at **wide (1080)** |
| 1080 | `embeds.css:41` (`.embeds-grid`) | **wide** (canonical) |

Consolidated set: **compact 640 · medium 768 · wide 1080**.

Note the off-by-one: `DataList` uses `innerWidth < 640` while CSS uses `max-width: 640px` (`<=`),
so at exactly 640px the row layout and row padding disagree.

## 1. Consolidate breakpoints into named tokens

**Files:** `packages/theme/tokens.css`, `packages/theme/src/index.ts`,
`apps/admin/src/settings/settings.css`, `apps/admin/src/components/DataTabManager.css`,
`apps/admin/src/components/DataTabManager.tsx`, `apps/admin/src/components/DataList.tsx`,
`apps/admin/src/dashboard/dashboard.css`.

**Changes**

- `tokens.css`: add a documented comment block naming the three values and stating the rule
  (compact = phone, one column; medium = tablet, chrome collapses; wide = narrow desktop,
  multi-column grids relax). **Do not add `--bp-*` custom properties** — see decision 2. Comments
  are stripped by `build.mjs`'s `minifyCss`, so `generated.ts` stays byte-identical and
  `tokens.test.ts` keeps passing with no rebuild.
- `packages/theme/src/index.ts` (hand-written, *not* the generated artifact):
  `export const breakpoints = { compact: 640, medium: 768, wide: 1080 } as const`. Source of truth
  for the two JS consumers.
- `DataList.tsx:520`: `DEFAULT_MOBILE_BREAKPOINT_WIDTH = breakpoints.compact`, and change
  `isViewportMobile` from `<` to `<=` so it agrees with `max-width` at exactly 640.
- `DataTabManager.tsx:1213,1228`: build the query from `` `(max-width: ${breakpoints.medium}px)` ``.
- `settings.css:53`: 560 → 640. `DataTabManager.css:846`: 720 → 768 (fold into the existing 768 block).
- `dashboard.css:246`: replace the single 900 query with
  `@media (max-width: 1080px) { .db-grid { grid-template-columns: repeat(2, minmax(0,1fr)) } .db-span3 { grid-column: span 2 } }`
  and `@media (max-width: 768px) { .db-grid { grid-template-columns: 1fr } .db-span2, .db-span3 { grid-column: span 1 } }`.

**Acceptance:** at 1280px, dashboard / settings / embeds / workspace render pixel-identically to
`main`. At 1000px the dashboard shows 2 columns (today: 3). At 900px the tab-strip dropdown has
*not* appeared. `grep -rn "max-width: *[0-9]" --include=*.css` returns only 640, 768, 1080.
`npm test` green without regenerating `generated.ts`.

**Est:** 45–60 min. **Risk:** low.

## 2. Tier A — speaker portal at 390

**Files:** `apps/api/src/routes/portal.ts` (`PORTAL_CSS` only).

**Changes:** one `@media(max-width:640px)` block appended after existing rules so desktop defaults
are untouched: `dl.detail{grid-template-columns:1fr;gap:.15rem .8rem}` with
`dl.detail dt{margin-top:.5rem}`; `.wrap{padding:1rem .75rem 3rem}`; `nav.pills{gap:.25rem}` and
`nav.pills a{padding:.5rem .8rem}`; `button,.btn{min-height:44px;padding:.6rem 1.1rem}`;
`.task .t-head{gap:.4rem}`. No markup changes.

**Acceptance:** at 390 — `/portal/:slug`, `/submissions`, `/submissions/:id`, `/profile`, `/tasks`
have zero horizontal page scroll; submission detail reads label-above-value; every button and nav
pill ≥44px tall; the headshot file input opens the camera roll; the biography counter is visible
while typing. At 768 and 1280, unchanged.

**Est:** 45 min. **Risk:** low.

## 3. Tier A — magic-link login and the shared Worker page shell

**Files:** `apps/api/src/html.ts` (`CSS`).

**Changes:** one appended `@media (max-width:640px)` block: `body{padding:1.5rem .75rem}`;
`main.card{padding:1.25rem}`; `h1{font-size:1.3rem}`; `button{min-height:44px;width:100%}`; and
`table{display:block;overflow-x:auto;white-space:nowrap}` so reused listing pages scroll their
table rather than the document.

**Acceptance:** at 390 — `/auth/login` and the sent / expired / error variants fit with no
horizontal scroll, the email input is full width with a ≥44px submit, and the dev magic-link box
wraps rather than overflows. At 1280, byte-identical rendering.

**Est:** 30 min. **Risk:** low.

## 4. Tier A — public CFP wizard at 390

**Files:** `packages/ui/src/SubmitPage.tsx` (`wizardCss`), `packages/ui/src/Page.tsx` (`baseCss`).

**Changes:** appended `@media (max-width:640px)` blocks only. `Page.tsx`:
`main{padding:2rem 1rem 3rem}`. `SubmitPage.tsx`: `.sb-main{padding:1.5rem 1rem 3rem}`;
`.sb-review > div{grid-template-columns:1fr;gap:.15rem}`; `.sb-button{min-height:44px}`;
`.sb-nav{gap:.75rem}`;
`.sb-stepper{position:sticky;top:0;background:var(--bg);z-index:2;padding:.5rem 0;margin:0 0 1rem}`
(the sticky step header docs/11 §5 promised); `.sb-choices label,.sb-check{min-height:36px}`.

**Acceptance:** at 390 — every wizard step fits without horizontal scroll; the step header stays
visible while scrolling a long question list; the review step reads label-above-value; Back/Next
both reachable without zoom and ≥44px. At 1280, unchanged (the sticky rule is inside the query).
`SubmitPage.test.tsx` still green.

**Est:** 45–60 min. **Risk:** low. Note `.sb-main` beats `Page`'s element-level `main` rule on
specificity, so both edits are needed.

## 5. Tier A/B — public event pages at 390

**Files:** `packages/ui/src/EventShell.tsx` (`eventShellCss`),
`packages/ui/src/widgets/AgendaWidget.tsx` (`agendaCss`),
`packages/ui/src/widgets/GalleryWidget.tsx`, `packages/ui/src/widgets/ScheduleWidget.tsx`.

**Changes:** appended compact-width blocks. `EventShell`: `.event-shell-header h1{font-size:1.5rem}`,
`.event-shell-nav{overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch}` with
`a{white-space:nowrap}` so five tabs become a swipe strip instead of three wrapped rows.
`AgendaWidget`: keep the existing 640 block, add `.ag-scroll{-webkit-overflow-scrolling:touch}` and
a scroll hint ("Scroll sideways for more rooms") via CSS `::after` on `.ag-toolbar` inside the
compact block — no new markup. `ScheduleWidget`: `.schedule-star{min-width:44px;min-height:44px}`,
`.schedule-export-button{min-height:40px}`. `GalleryWidget`:
`.gallery-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}` and
`.gallery-modal{padding:1rem}`.

**Acceptance:** at 390 — `/e/:slug/sessions`, `/speakers`, `/gallery`, `/schedule` have no
page-level horizontal scroll; the gallery shows 2 tiles per row; the star toggle is tappable;
`/e/:slug/agenda` scrolls horizontally *inside* `.ag-scroll` with the time gutter pinned, and the
session modal is fully readable. At 1280, unchanged. Existing widget tests green.

**Est:** 60–75 min. **Risk:** low.

## 6. `DesktopOnlyNotice` — the shared Tier C refusal panel

**Files (new):** `packages/ui/src/DesktopOnlyNotice.tsx`, `packages/ui/src/DesktopOnlyNotice.test.tsx`.
**Files (edited):** `packages/ui/package.json` (add `"./desktop-only"` to `exports`),
`packages/ui/src/index.ts`, `apps/admin/package.json` (add `"@kms/ui": "*"`).

**Shape:** a props-only presentational component — no viewport logic inside it.

- `title` — e.g. "The agenda builder needs a wider window."
- `children` / `message` — one sentence saying why, in the docs/11 §7 register.
- `summary?: ReactNode` — optional read-only digest (today's schedule, the form's question count,
  the file's detected columns).
- `action?: { label: string; onClick?: () => void; href?: string }` — exactly one permitted action;
  the type allows only one.
- Renders its own `<style>` from an exported `desktopOnlyCss` string, matching the widget idiom in
  `AgendaWidget`/`EventShell` (the public pages have no stylesheet pipeline, and one instance is on
  screen at a time).
- `desktopOnlyCss` also exports the composition classes `.kms-compact-only { display:none }` /
  `@media (max-width:640px){ .kms-compact-only{display:block} .kms-wide-only{display:none} }` —
  **this is the CSS-only gate**, so screens need no JS viewport detection.

**Import via the subpath** (`@kms/ui/desktop-only`), not the barrel: `index.ts` pulls
`SubmitPage`/`EventPage` into the graph and the admin bundle must not carry them. The component
must be plain JSX with no hooks or DOM APIs so it works under both real React (admin) and
`preact/compat` (public build).

**Acceptance:** unit test in the `ui` vitest project renders the panel and asserts the message, the
summary slot, exactly one action button, and no `window`/`matchMedia` access.
`npm run build:admin` succeeds and the admin bundle grows by no more than ~1KB gzip (check
`dist/app/assets` before/after). No screen consumes it yet — inert and safe to stop after.

**Est:** 60 min. **Risk:** low.

## 7. Tier C — wire the refusal panel

**Files:** `apps/admin/src/App.tsx` (settings + agenda dispatch),
`apps/admin/src/forms/FormsSection.tsx` / `FormBuilder.tsx`,
`apps/admin/src/settings/SettingsSection.tsx` and `EmailTemplatesCard.tsx`,
`apps/admin/src/workspace/ImportWizard.tsx`, `apps/admin/src/agenda/AgendaSection.tsx`,
plus small appended compact blocks in `forms.css`, `settings.css`, `import.css`, `agenda.css`.

Five refusals, each a `.kms-compact-only` wrapper plus `.kms-wide-only` around the existing tree:

1. **Form builder** (`FormBuilder`, when `route.form` is set). Summary: form name, status, question
   count. Action: "Preview the public form" (existing link). The list at `/app?v=forms` stays usable.
2. **Agenda grid modes** (`AgendaSection`, `view` ∈ day/week/rooms/month). Summary: today's sessions
   as a read-only list — the existing `list` mode component. Action: "Move a session" (the existing
   dialog path in `agenda/dialogs.tsx`). `list` and `conflicts` stay as they are. Because a 0-width
   mount of `TimeGrid`/`RoomsBoard` (which measure via `useElementSize`) is genuinely hazardous,
   this one screen gates with `matchMedia` — the precedent `DataTabManager.tsx:1213` established —
   rather than `display:none`.
3. **Importer column mapping** (`ImportWizard`, map step only). Summary: file name, row count,
   detected columns. Action: "Cancel import". File-pick and done steps left alone.
4. **Email template editor** (`EmailTemplatesCard`). Summary: template name and subject. Action:
   "Send a test email" if it exists, else no action.
5. **Settings hub** (`SettingsSection`). Summary: event name, timezone, slug. Action: "Open the
   speaker portal".

Workspace bulk/anchor affordances: hide `.bulk-bar` and the global-anchor chip below compact
(`review.css`, `DataTabManager.css`) rather than refusing the whole workspace — per decision 3.

**Acceptance:** at 390 each of the five shows the panel, the read-only summary and exactly one
action; nothing renders a squashed grid; no console errors and no zero-width layout warnings from
the agenda. At 768 the panels do **not** appear (the gate is compact/640, so a tablet still gets the
real screens). At 1280, identical to `main`.

**Est:** 2–2.5 h. **Risk:** medium — five call sites, each independently revertable.

## 8. Tier B — admin content polish (verified at 768)

**Files:** `apps/admin/src/workspace/review.css`, `apps/admin/src/dashboard/dashboard.css`,
`apps/admin/src/shell.css` (`.detail-panel`).

**Changes**, all appended compact-width blocks:

- `.review-shell{flex-direction:column}`;
  `.review-queue{flex:0 0 auto;max-height:35vh;border-right:0;border-bottom:1px solid var(--border)}`;
  `.review-pane{padding:var(--space-3)}`; `.score-scale{flex-wrap:wrap}` with
  `button{min-width:44px;min-height:44px}` — read an abstract, tap a score, next.
- `.db-shell{padding:.75rem .75rem 2rem}`;
  `.db-bar-row,.db-funnel-row{grid-template-columns:minmax(70px,1fr) 1fr 3rem}`;
  `.db-switcher{overflow-x:auto;flex-wrap:nowrap}`.
- `.detail-panel{padding:var(--space-3)}` and `.detail-panel dl{grid-template-columns:1fr}` so the
  single-submission approve/decline panel reads top-to-bottom; `.detail-actions` buttons ≥44px.

**Acceptance at 768** (the shell's 184px sidebar leaves 584px, so these are verifiable before item
9): the review queue sits above the pane, score buttons are tappable, the dashboard's
outstanding-tasks card and its nudge button are fully visible, and a submission detail panel shows
Approve/Decline without horizontal scroll. **390 verification is deferred to item 9.** At 1280,
unchanged.

**Est:** 60–90 min. **Risk:** low.

## 9. Admin shell compact chrome — the riskiest surgery, last

**Files:** `apps/admin/src/shell.css`, `apps/admin/src/App.tsx` (l.1865–1939 only).

**Changes:** below **medium (768)** turn the fixed 184px sidebar into a top bar plus a slide-over
drawer:

- `.shell{flex-direction:column}`; `.shell-sidebar` becomes
  `position:fixed;left:0;top:0;bottom:0;width:min(260px,80vw);z-index:60;transform:translateX(-100%);transition:transform .15s`
  with an `.is-open` modifier at `translateX(0)`, plus a `.shell-scrim` overlay. All of it inside
  the media query — desktop rules untouched.
- A new `.shell-topbar` (hamburger + brand + event name), rendered unconditionally in `App.tsx` but
  `display:none` above 768. One `useState` for open/closed, closed on nav-item click and on Escape
  — mirroring the existing `isMobileMenuOpen` idiom in `DataTabManager.tsx:1211`.
- `.shell-main{min-height:0}` unchanged; the media query only adds `padding-top` compensation.

**Acceptance at 390:** the sidebar is off-screen by default and the content pane is the full 390px;
the hamburger opens the drawer over a scrim; Escape and a nav tap close it; focus returns to the
hamburger. Then re-verify every earlier admin item at 390 — dashboard cards single column,
workspace showing DataList mobile card rows with the tab dropdown, review queue stacked, the five
Tier C panels. At **768** the drawer behaviour is active and the tab strip is a dropdown (both
switch at the medium token). At **1280**: sidebar visible at 184px, no top bar, zero pixel diff
against `main`.

**Est:** 2–3 h. **Risk:** high — the one item that touches the layout every admin screen sits
inside. Land it alone, on its own commit, with a 1280px before/after screenshot pair.

## Sequencing and stop-lines

Items 1–5 are public/speaker surfaces and carry no admin risk; stopping after item 5 delivers all
of Tier A. Item 6 is inert. Item 7 makes the admin's Tier C screens honest even at today's cramped
width. Item 8 improves Tier B at tablet width. Item 9 is the only structural change and is
deliberately last; if cut, items 1–8 still stand and the admin is exactly as it is today on a phone.

Rough total: **9–12 hours**.

## Other fixed-width flex children (same habit as the shell)

`.review-queue` 300px (`review.css:400`), `.builder-rail` 200px (`forms.css:163`),
`.detail-panel dl` `120px 1fr`, `dl.detail` `150px 1fr` in the portal, `.sb-review` `11rem 1fr` in
the CFP. All are addressed by the items above.

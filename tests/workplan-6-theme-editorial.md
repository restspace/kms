# Workplan 6 — "Editorial Broadsheet" theme (Mockup 1)

Reference mockup: **`tests/screenshots/mockup-1-rev2.png`** — build against this
one. It carries the §5.2 decisions (deep ink blue accent, warm near-black text).
`tests/screenshots/mockup-1.png` is the original exploration and is superseded;
its brick-red accent is not the direction. Both are derived from the current
dashboard at `tests/screenshots/dashboard.png`.

Status: **implemented** (all 8 steps of §6). This remains the scoping document
— it is not a change log, and it still describes the reasoning rather than the
result. Two things it says are now out of date: the §5.1 dark-mode question was
answered by designing an ink-on-dark counterpart, and the audit in §2/§4 counted
CSS only, so it missed ~21 hardcoded colours in the dashboard's chart TSX.

## 1. What the mockup actually changes

Layout, copy, component structure and information architecture are identical to
today. Every difference is presentational:

| Aspect | Now | Mockup 1 |
| --- | --- | --- |
| Ground | cool grey `#f5f6f8` | warm paper `#FAF7F0` |
| Text | slate `#1f2937` | ink navy, near-black warm |
| Accent | blue `#2563eb` | deep ink blue (see §5.2 — supersedes the brick red in the image) |
| Headings | system sans, 1.25rem / 650 | high-contrast display serif, larger |
| Section labels | 11px uppercase sans, 0.05em | small-caps serif, wider tracking |
| Cards | 1px border on white surface | hairline rules, surface = ground |
| Sidebar nav | sans | serif |
| Elevation | flat, shadows on overlays only | unchanged (already correct) |
| Table body / grids | sans 13px | unchanged — stays sans |

That last row is the important one and the mockup gets it right: the serif is a
*display* face only. Grid rows, table bodies, form inputs and data stay on the
existing sans. Any implementation that puts the serif into `--font-ui` wholesale
will wreck legibility at 13px in dense tables.

## 2. Why this is cheaper than it looks

`apps/admin/src/theme.css` already exists and is a real token layer — colour,
type, density, three explicit theme states, with a header comment forbidding
components from using raw values. The admin SPA is largely compliant:

- 5,667 lines of admin CSS, of which only **41 hardcoded hex values** and
  **2 `rgba()` calls** sit outside `theme.css`.
- Only **3 stray `font-family`** declarations (all mono, in `embeds.css` and
  `settings.css`) bypass the tokens.
- **9 `box-shadow`** declarations outside `var(--shadow-overlay)`.

So for the admin SPA the bulk of the work is *token substitution*, not a rewrite.
The cost is concentrated in the surfaces that never got tokenised at all
(§4) and in the judgement calls (§5).

## 3. Work items — admin SPA

### 3.1 Split the type tokens (prerequisite)

`theme.css` has one `--font-ui`. The theme needs three roles:

```
--font-display   /* serif: h1, card titles, nav, section labels */
--font-ui        /* sans: unchanged, all data/controls/grids */
--font-mono      /* unchanged */
```

Then move each heading rule onto `--font-display`. Sites to touch, from the
grep: `dashboard.css` (h1, `.db-nudges-title`, card titles, stat values),
`shell.css` (`.shell-brand`, nav items), `DataTabManager.css`,
`DataList.css` column headers, `forms.css`, `agenda.css`, `review.css`,
`settings.css`, `embeds.css` section heads. Roughly 40–60 rules.

Add `--tracking-label` and a small-caps convention rather than re-declaring
`letter-spacing: 0.05em` in the dozen places that currently hardcode it.

### 3.2 Repalette the tokens

Rewrite the colour blocks in `theme.css` for all **three** theme states
(bare `:root`, the `prefers-color-scheme: dark` block, and
`[data-theme="dark"]`). See §5.1 — the dark variant is undesigned.

### 3.3 Card → rule treatment

The mockup replaces card chrome with hairline rules and lets the surface equal
the ground. This is not a token swap; it is per-component. Affected:
`dashboard.css` (stat tiles, chart panel, forms panel, recent-submissions
table), `DataList.css`, `DataTabManager.css`, `review.css`, `agenda.css`,
`files.css`. Budget real time here — it is the largest single item and the one
most likely to expose layout assumptions that were relying on a border for
spacing.

Also remove or re-scope the 9 non-overlay `box-shadow` declarations.

### 3.4 Tokenise the stragglers

41 hex + 2 `rgba()` in: `files.css` (14), `import.css` (6), `embeds.css` (6),
`DataTabManager.css` (6), `settings.css` (3), `DataList.css` (3),
`shell.css` (2), `dialogs.css` (1), `RoomsTracksFields.css` (1).
Each needs a judgement call: map to an existing token, or add one. Do this
*before* the repalette, so the repalette actually reaches them.

### 3.5 Font loading

No CSP is set on the app today, so a CDN link would work — but self-host
anyway: it is a Workers app with an asset directory already
(`apps/public/public/`, served via the `[assets]` binding in `wrangler.toml`),
and a third-party font request on every admin page load is avoidable latency.

- Add `apps/public/public/static/fonts/`, latin-subset `woff2`, weights limited
  to what the mockup uses (regular + one bold; italic only if the "updated 5s
  ago" and form-status italics in the mockup are kept — they are).
- `@font-face` with `font-display: swap` and `size-adjust` / `ascent-override`
  tuned against the sans fallback, or the heading reflow on load will be a
  visible CLS jump on the dashboard h1.
- Preload the display face from `apps/admin/index.html`.
- Confirm the asset route sets long-lived cache headers for `/static/fonts/*`.

**Licensing is an open decision.** The mockup prompt referenced Playfair
Display / Canela. Playfair Display and Source Serif 4 are OFL and can be
self-hosted freely; Canela, Freight, Tiempos and Roslindale are commercial and
need a purchased web licence sized to traffic. Pick before implementation
starts — the metrics differ enough that swapping later means re-tuning the §3.1
sizes and the `size-adjust` values.

## 4. Work items — everything outside the admin SPA

The brief was "an example for changing theming of the whole app", so these are
in scope, and they are where the real cost is. None of them consume
`theme.css`; each carries its own hardcoded palette.

| Surface | File | Hardcoded colours | Notes |
| --- | --- | --- | --- |
| Server-rendered auth/error pages | `apps/api/src/html.ts` | 21 | Inline `<style>` string; own font stack |
| Speaker portal | `apps/api/src/routes/portal.ts` | 58 | Largest single offender |
| Public event pages | `packages/ui/src/Page.tsx`, `EventShell.tsx` | 2 | Already uses `var(--accent)` in one place — partially tokenised |
| Landing page | `apps/api/src/routes/landing.tsx` | 0 | Clean; inherits |
| Email templates | `packages/email/src/render.ts` | inline | See below |

The right move is to extract a shared token stylesheet emitted by both the
Worker-rendered pages and the SPA, rather than hand-editing 79 hex values into
a second palette that will immediately drift from `theme.css`. That extraction
is itself a work item and arguably should land *first*.

**Email** is a separate problem: email clients do not reliably support web
fonts, so `render.ts` gets a serif *stack* (`Georgia, 'Times New Roman', serif`)
rather than the real face, and the palette has to survive Outlook. Treat the
email theme as "sympathetic to", not "identical to", the app.

**Embeds are explicitly out of scope.** `apps/api/src/routes/embed.ts` takes a
host-supplied `data-accent` and emits `:root{--accent:...}` into the widget
frame — these render on customers' own sites and must keep taking the host's
colour, not ours. `apps/api/test/embed.test.ts:207,214` asserts this. The only
question is whether the *default* fallback accent moves from `#2563eb` to the
new `#2C4A73`; recommend yes, and update that test.

## 5. Risks and decisions needed

### 5.1 Dark mode is undesigned

The mockup is a light, paper-toned theme. `theme.css` defines dark twice
(OS-preference and explicit choice) and its header comment commits to "both
themes defined explicitly". A paper theme has no automatic dark translation —
"warm paper" inverted is not a design, it is a guess. Someone needs to decide:
design an ink-on-dark counterpart, or drop dark mode support. Do not let this
get discovered during implementation.

### 5.2 Accent — DECIDED: deep ink blue

The mockup renders the accent as brick red. That put the primary-action colour
and the destructive-action colour in the same hue family — the active nav item,
the chart line and the "delete" button would all read as the same signal.

**Decision: the theme takes a deep ink blue accent and red stays exclusive to
`--danger`.** `mockup-1-rev2.png` reflects this and is the reference to build
against; the page contains no red at all, which is correct — nothing on the
dashboard is destructive or errored.

Proposed values, all contrast-checked against the `#FAF7F0` paper ground:

| Token | Value | Contrast |
| --- | --- | --- |
| `--accent` | `#2C4A73` | 8.4:1 on paper; white-on-it 9.0:1 |
| `--accent-strong` | `#1F3A5F` | 10.7:1 on paper (hover/pressed/active nav) |
| `--accent-contrast` | `#FFFFFF` | — |
| `--accent-soft` | `#ECEFF5` | accent text on it 10.0:1 |
| `--accent-soft-hover` | `#E8EDF5` | 9.8:1 |
| `--accent-border` | `#B9C6DA` | non-text |

Dark-theme accent (pending §5.1): `#8FB4E0` gives 8.5:1 on the existing
`#12151a` ground, `#A8C6E8` gives 10.4:1 for `--accent-strong`.

**Consequence for the body text colour.** A deep ink blue accent will not read
as an accent if the body text is also ink navy — at 10.7:1 the two are nearly
the same value and only differ in hue. So the §1 "ink navy" text should instead
be a *warm* near-black: `#1C1917` (16.4:1) or `#211D19` (15.7:1). That keeps
the blue clearly separated by hue as well as weight, and suits the paper ground
better than a cool navy would. This is a change from what the mockup shows.

Danger is unaffected but worth noting: `#dc2626` scrapes 4.51:1 on the warm
ground versus 4.83:1 on today's cool grey. Use `#b91c1c` (6.1:1) for danger
*text* on paper and keep `#dc2626` for filled danger buttons.

### 5.3 Status colours on warm ground

The 12 `--status-*` tokens are tuned for a cool grey ground. On `#FAF7F0` the
existing greens and yellows will read muddy, and the `withdrawn` slate chip
will look distinctly blue-cast. All 12 need re-tuning per theme state — 36
values total. `theme.css` also documents the rule that status colour never
travels without a label, which the mockup respects; keep it.

### 5.4 Contrast

Small-caps at 11px with wide tracking on a warm ground is the riskiest
combination in the mockup. Every label/ground and accent/ground pair needs a
4.5:1 check (3:1 for the large display headings). The accent pairs are already
checked in §5.2; the muted caption greys are the remaining likely failures, and
they need re-deriving against the warm ground rather than carrying over from
the cool-grey palette.

### 5.5 Serif in dense UI

Stated in §1 but repeating as a risk: resist scope creep of the serif into
grids. If it looks tempting in review, remember the mockup is 1536px wide
showing one table row — it is not showing a 40-row DataList at 13px.

## 6. Suggested sequence

1. Decide: font licence, dark-mode question (§5.1). ~~Accent hue~~ — settled,
   deep ink blue (§5.2).
2. Tokenise the 43 stray values in the admin SPA (§3.4).
3. Extract the shared token stylesheet so Worker-rendered pages consume it (§4).
4. Split the type tokens (§3.1) — still on the current palette, so it lands
   as a pure-refactor commit that changes nothing visually.
5. Font loading (§3.5).
6. Repalette all three theme states (§3.2) + status re-tune (§5.3).
7. Card → rule treatment (§3.3).
8. Contrast audit (§5.4), email (§4), embed default accent (§4).

Steps 2–4 are safe, reviewable, and useful regardless of whether Mockup 1 is
the direction that ships. Steps 6–7 are the point of no return.

## 7. What is not covered here

- No visual-regression baseline exists. `tests/screenshots/` holds ad-hoc
  captures, not a snapshot suite, so a repalette of this size has no automated
  safety net. Worth adding before step 6, not after.
- Mockups 2 and 3 (`tests/screenshots/mockup-2.png`, `mockup-3.png`) are not
  scoped. Sections 3.1, 3.4, 3.5 and 4 are direction-agnostic and would be
  reused by either.

export { tokensCss } from './generated'

/**
 * Breakpoints, mirroring the comment block in tokens.css. CSS keeps literals
 * (custom properties are invalid in a @media prelude); these exist for the two
 * JS consumers that must agree with those literals — DataList's card-row
 * switch at compact and DataTabManager's tab-strip dropdown at medium.
 */
export const breakpoints = { compact: 640, medium: 768, wide: 1080 } as const

/**
 * Status chips for the Worker-rendered surfaces (`<span class="chip st-…">`).
 * The admin SPA has its own markup convention (`.status-chip.status-…`, in
 * apps/admin/src/theme.css) but both read the same --status-* tokens, so the
 * colours cannot drift — only the selectors differ.
 *
 * Per the token layer's rule, status colour never travels without a label:
 * the dot is decorative and always sits beside chip text.
 */
export const statusChipCss = `
.chip{display:inline-flex;align-items:center;gap:.35rem;padding:.1rem .6rem;border-radius:999px;font-size:.75rem;font-weight:600;white-space:nowrap}
.chip .dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:currentColor}
.st-draft{background:var(--status-draft-bg);color:var(--status-draft-text)}
.st-pending{background:var(--status-pending-bg);color:var(--status-pending-text)}
.st-accept_queue{background:var(--status-queue-bg);color:var(--status-queue-text)}
.st-accepted{background:var(--status-accepted-bg);color:var(--status-accepted-text)}
.st-decline_queue{background:var(--status-queue-bg);color:var(--status-queue-text)}
.st-declined{background:var(--status-declined-bg);color:var(--status-declined-text)}
.st-withdrawn{background:var(--status-withdrawn-bg);color:var(--status-withdrawn-text)}
`.trim()

/**
 * Shared element defaults for the Worker-rendered pages. The admin SPA does
 * not use this — it has its own reset in theme.css — but the auth/error pages,
 * the speaker portal and the public event pages all start from here so a
 * token change reaches them without hand-editing three palettes.
 */
export const baseCss = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui);line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
a:hover{color:var(--accent-strong)}
.muted{color:var(--text-muted)}
.small{font-size:.85rem}
.code{font-family:var(--font-mono);font-size:.82rem;color:var(--text-muted)}
label{display:block;font-weight:600;font-size:.85rem;margin:.7rem 0 .25rem}
input[type=text],input[type=email],input[type=url],input[type=tel],input[type=password],select,textarea{width:100%;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);font:inherit;background:var(--surface);color:var(--text)}
textarea{resize:vertical}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.banner{background:var(--notice-soft);color:var(--notice-text);border:1px solid var(--notice-border);border-radius:var(--radius);padding:.5rem .8rem;font-size:.88rem;margin-bottom:1rem}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}
`.trim()

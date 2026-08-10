/** @jsxImportSource react */
// The pragma is load-bearing. This is the one file in packages/ui that both
// builds compile: the admin bundles real React, while apps/public aliases
// react/jsx-runtime onto preact/jsx-runtime. Without it the nearest tsconfig
// (the repo root's, which targets preact) wins and the admin renders preact
// vnodes inside a React tree — React error #31.

/**
 * Renderable slot. Deliberately loose: this file is compiled under two JSX
 * type universes (React's in the admin, preact's in the public build) and
 * neither ReactNode nor ComponentChildren is assignable in both — naming
 * either one turns the *other* build's typecheck red.
 */
type Slot = any

/**
 * The Tier C refusal panel (docs/15 §6, docs/16 item 6).
 *
 * The rule the tiers encode: acting on one record is phone-shaped, arranging
 * many records relative to each other is not. Where a screen is the second
 * kind we neither hide it nor let it squash — we say so, show a read-only
 * digest of what is there, and offer the one action still worth taking.
 *
 * Deliberately props-only: no hooks, no window, no matchMedia. The viewport
 * decision belongs to the caller, and is normally the CSS-only gate below
 * (`.kms-compact-only` / `.kms-wide-only`) rather than JS at all. That also
 * keeps this renderable under both real React (admin) and preact/compat
 * (public build).
 */
export interface DesktopOnlyNoticeAction {
  label: string
  onClick?: () => void
  href?: string
}

export interface DesktopOnlyNoticeProps {
  /** e.g. "The agenda builder needs a wider window." */
  title: string
  /** One sentence saying why. Prefer `children` for anything richer. */
  message?: string
  children?: Slot
  /** Optional read-only digest — today's schedule, the form's question count. */
  summary?: Slot
  /** Exactly one action is permitted; the type allows only one. */
  action?: DesktopOnlyNoticeAction
}

export function DesktopOnlyNotice({ title, message, children, summary, action }: DesktopOnlyNoticeProps) {
  return (
    <div className="kms-desktop-only">
      <style>{desktopOnlyCss}</style>
      <h2 className="kms-desktop-only-title">{title}</h2>
      {message && <p className="kms-desktop-only-message">{message}</p>}
      {children}
      {summary && <div className="kms-desktop-only-summary">{summary}</div>}
      {action &&
        (action.href ? (
          <a className="kms-desktop-only-action" href={action.href} onClick={action.onClick}>
            {action.label}
          </a>
        ) : (
          <button type="button" className="kms-desktop-only-action" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
    </div>
  )
}

/**
 * Rendered inline by the component, matching the widget idiom in
 * AgendaWidget/EventShell: the public pages have no stylesheet pipeline and
 * one panel is on screen at a time.
 *
 * The two composition classes are the gate itself — a screen wraps its real
 * tree in `.kms-wide-only` and the panel in `.kms-compact-only` and needs no
 * viewport detection of its own.
 */
export const desktopOnlyCss = `
.kms-compact-only { display: none; }
.kms-desktop-only { border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.15rem; margin: 0 auto; max-width: 34rem; background: var(--surface); color: var(--text); }
.kms-desktop-only-title { font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; margin: 0 0 .4rem; }
.kms-desktop-only-message { margin: 0 0 .9rem; color: var(--text-secondary); font-size: .92rem; }
.kms-desktop-only-summary { border-top: 1px solid var(--border); padding-top: .8rem; margin: 0 0 .9rem; font-size: .9rem; }
.kms-desktop-only-action { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: .5rem 1.1rem; border: 0; border-radius: var(--radius); background: var(--accent); color: var(--accent-contrast); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.kms-desktop-only-action:hover { background: var(--accent-strong); color: var(--accent-contrast); }

@media (max-width: 640px) {
  .kms-compact-only { display: block; }
  .kms-wide-only { display: none; }
}
`

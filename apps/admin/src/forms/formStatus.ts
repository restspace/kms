// Effective form status (docs/04 defect: "status duality" — two independent
// controls, status and close_at, with no coordination). submit.tsx's
// isFormClosed() is the canonical public-facing gate: closed = explicit
// status='closed' OR a close_at in the past. The admin side (Forms list chip,
// builder Status control, and the list's Close/Reopen action) must agree with
// that same definition instead of reading raw `status` alone, or the admin UI
// can show "Open" for a form the public already treats as closed.

export type EffectiveFormStatus = 'open' | 'closed' | 'closed-by-date'

/** Mirrors submit.tsx's isFormClosed(), plus distinguishing *why* it's closed
 * so the UI can explain the duality instead of just saying "Closed". */
export function effectiveFormStatus(form: { status: string; close_at: string | null }): EffectiveFormStatus {
  if (form.status === 'closed') return 'closed'
  if (form.close_at !== null && new Date(form.close_at).getTime() < Date.now()) return 'closed-by-date'
  return 'open'
}

export function isEffectivelyClosed(form: { status: string; close_at: string | null }): boolean {
  return effectiveFormStatus(form) !== 'open'
}

export const EFFECTIVE_STATUS_LABEL: Record<EffectiveFormStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  'closed-by-date': 'Closed (by date)',
}

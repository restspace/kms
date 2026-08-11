// ABS-01 review-window derivation, shared between the evaluation routes and
// the submission-comment thread gate (workplan 7 D3) so "the round has
// closed" means exactly one thing.

export interface ReviewWindow {
  opens_at: string | null;
  closes_at: string | null;
}

/**
 * ABS-01: a plan may carry an optional review window. Null on either side is
 * "no bound", so a plan that never sets dates is always open — every existing
 * plan keeps its current behaviour.
 */
export function reviewWindowState(
  plan: ReviewWindow,
  now = Date.now(),
): { open: boolean; reason: 'not_yet_open' | 'closed' | null } {
  if (plan.opens_at) {
    const opens = Date.parse(plan.opens_at);
    if (Number.isFinite(opens) && now < opens) return { open: false, reason: 'not_yet_open' };
  }
  if (plan.closes_at) {
    const closes = Date.parse(plan.closes_at);
    if (Number.isFinite(closes) && now > closes) return { open: false, reason: 'closed' };
  }
  return { open: true, reason: null };
}

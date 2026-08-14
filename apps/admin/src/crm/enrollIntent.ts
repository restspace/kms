/**
 * The Pipeline board's "+ Enroll New" round trip.
 *
 * The pipeline can only enroll contacts that already exist, so "+ Enroll New"
 * hands the organiser over to the org-wide directory's create form (Workspace,
 * "All events", `rec=__new__`). This module is the thread back: the button
 * records an *intent* before navigating, the directory's contact `onUpsert`
 * consumes it after a successful create — enrolling the fresh contact at
 * `identified` and bouncing back to the board — and the board reads the
 * handoff to flash the card that just appeared.
 *
 * sessionStorage rather than a module variable so the trip survives a reload
 * of the deep-linked create form, and per-tab so two windows can't cross
 * wires. Every accessor is storage-safe (private mode / disabled storage just
 * degrades to "no intent", i.e. today's behaviour).
 */

const INTENT_KEY = 'kms:pipeline-enroll-intent'
const HIGHLIGHT_KEY = 'kms:pipeline-enroll-highlight'

/** Starting stage for someone created through this shortcut. */
export const ENROLL_NEW_STAGE = 'identified'

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the round trip simply doesn't happen */
  }
}

function drop(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Arm the round trip. Called by "+ Enroll New" just before navigating. */
export const setEnrollIntent = (): void => write(INTENT_KEY, '1')

/** Is a create-then-enroll trip in flight? (Does not consume it.) */
export const hasEnrollIntent = (): boolean => read(INTENT_KEY) === '1'

/** Consume the intent — true exactly once per "+ Enroll New" press. */
export function takeEnrollIntent(): boolean {
  const armed = hasEnrollIntent()
  drop(INTENT_KEY)
  return armed
}

/**
 * Disarm without consuming. The organiser abandoned the create form (they
 * navigated away), so the *next* contact they happen to create somewhere else
 * must not be silently enrolled.
 */
export const clearEnrollIntent = (): void => drop(INTENT_KEY)

/** Tell the board which card to flash when it next loads. */
export const setEnrollHighlight = (cardId: string): void => write(HIGHLIGHT_KEY, cardId)

/** Read-and-clear the card id the board should flash. */
export function takeEnrollHighlight(): string | null {
  const id = read(HIGHLIGHT_KEY)
  if (id) drop(HIGHLIGHT_KEY)
  return id
}

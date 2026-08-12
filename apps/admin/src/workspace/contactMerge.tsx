import { useEffect, useState } from 'react'
import { ModalDialog, appConfirm } from '../components/dialogs'
import {
  getDuplicateContacts,
  mergeContacts,
  type DuplicateContact,
  type DuplicatePair,
} from '../api'
import './contactMerge.css'

/**
 * Workplan 14 Wave B (decisions D1/D2): the Duplicates panel — candidate pairs
 * the org can merge, in the server's two tiers. Strong (same normalized email)
 * pairs are near-certainly one person; weak (same normalized name, different
 * emails) pairs get an extra explicit confirm before the merge is sent,
 * because legitimate namesakes exist and the server deliberately does not
 * auto-merge anything.
 *
 * Opened imperatively (openDuplicatesPanel / DuplicatesHost) for the same
 * reason the contact picker and import wizard are: its entry points are a
 * Speakers-tab toolbar button and the duplicate-name warning's "Merge
 * instead?" action, both plain data inside `buildWorkspaceConfig` with
 * nowhere to hang React state.
 */

// ---------------------------------------------------------------------------
// Pure field-resolution logic (pinned by contactMerge.logic.test.ts)
// ---------------------------------------------------------------------------

/** The fields the side-by-side picker can resolve, with display labels.
 * Mirrors the server's MERGE_IDENTITY_FIELDS + MERGE_PROFILE_FIELDS (minus
 * `links`/`headshot_asset_id`, which have no sensible textual side-by-side —
 * the winner's are kept, blanks filled from the loser, server-side). */
export const MERGE_PICKER_FIELDS: ReadonlyArray<{ field: keyof DuplicateContact & string; label: string }> = [
  { field: 'email', label: 'Email' },
  { field: 'first_name', label: 'First name' },
  { field: 'last_name', label: 'Last name' },
  { field: 'salutation', label: 'Salutation' },
  { field: 'honorific', label: 'Honorific' },
  { field: 'pronouns', label: 'Pronouns' },
  { field: 'gender', label: 'Gender' },
  { field: 'mobile_phone', label: 'Mobile' },
  { field: 'company', label: 'Company' },
  { field: 'job_title', label: 'Job title' },
  { field: 'biography', label: 'Biography' },
]

const blank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === ''

/**
 * The fields the picker must actually ask about: both records carry a value
 * and the values differ. Fields where only one side has a value need no pick —
 * the server keeps the winner's value and fills blanks from the loser.
 */
export function conflictingMergeFields(
  a: DuplicateContact,
  b: DuplicateContact,
): Array<{ field: string; label: string }> {
  return MERGE_PICKER_FIELDS.filter(({ field }) => {
    const av = a[field]
    const bv = b[field]
    return !blank(av) && !blank(bv) && String(av).trim() !== String(bv).trim()
  })
}

/**
 * What the merged record's fields will read after the merge — the picker's
 * preview, and the mapping the server applies: picked-from-loser fields take
 * the loser's value, everything else keeps the winner's, blanks filled from
 * the loser.
 */
export function resolveMergedValues(
  winner: DuplicateContact,
  loser: DuplicateContact,
  picks: Record<string, 'winner' | 'loser'>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { field } of MERGE_PICKER_FIELDS) {
    out[field] = picks[field] === 'loser' ? loser[field] : blank(winner[field]) ? loser[field] : winner[field]
  }
  return out
}

// ---------------------------------------------------------------------------
// Imperative open + host (the contactOrg.tsx picker pattern)
// ---------------------------------------------------------------------------

export interface DuplicatesPanelRequest {
  /** Called after at least one merge, so the grid can refetch. */
  onMerged?: () => void
}

let enqueue: ((request: DuplicatesPanelRequest) => void) | null = null
const pending: DuplicatesPanelRequest[] = []

/** Opens the Duplicates review panel. */
export function openDuplicatesPanel(request: DuplicatesPanelRequest = {}): void {
  if (enqueue) enqueue(request)
  else pending.push(request)
}

/** Renders once at the app root; services `openDuplicatesPanel` requests. */
export function DuplicatesHost() {
  const [queue, setQueue] = useState<DuplicatesPanelRequest[]>([])
  const current = queue[0] ?? null

  useEffect(() => {
    enqueue = (request) => setQueue((q) => [...q, request])
    if (pending.length > 0) {
      setQueue((q) => [...q, ...pending.splice(0, pending.length)])
    }
    return () => {
      enqueue = null
    }
  }, [])

  if (!current) return null
  return (
    <DuplicatesPanel key={queue.length} request={current} onClose={() => setQueue((q) => q.slice(1))} />
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const nameOf = (c: DuplicateContact): string =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email

function DuplicatesPanel({
  request,
  onClose,
}: {
  request: DuplicatesPanelRequest
  onClose: () => void
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; pairs: DuplicatePair[] }
  >({ status: 'loading' })
  const [openPair, setOpenPair] = useState<number | null>(null)
  const [mergedCount, setMergedCount] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const res = await getDuplicateContacts()
        if (!cancelled) setState({ status: 'ready', pairs: res.items })
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'The duplicates list failed to load.',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const close = () => {
    if (mergedCount > 0) request.onMerged?.()
    onClose()
  }

  const afterMerge = () => {
    setMergedCount((n) => n + 1)
    setOpenPair(null)
    setReloadToken((t) => t + 1)
  }

  return (
    <ModalDialog
      open
      width="lg"
      title="Possible duplicate contacts"
      onClose={close}
      footer={<button className="primary" onClick={close}>Done</button>}
    >
      <p>
        Pairs your organisation may know twice. <strong>Same email</strong> is a strong signal;{' '}
        <strong>same name</strong> alone can be two real people — check the records before merging
        those. Merging moves everything (sessions, tasks, messages, files, history) onto the record
        you keep; nothing is deleted, and the merge is recorded.
      </p>

      {state.status === 'loading' ? (
        <div className="settings-hint">Looking for duplicates…</div>
      ) : state.status === 'error' ? (
        <div className="settings-error" role="alert">
          {state.message}{' '}
          <button type="button" className="settings-ghost" onClick={() => setReloadToken((t) => t + 1)}>
            Retry
          </button>
        </div>
      ) : state.pairs.length === 0 ? (
        <div className="settings-hint">
          No duplicate candidates — every contact has a distinct email and name.
        </div>
      ) : (
        <ul className="merge-pairs">
          {state.pairs.map((pair, i) => (
            <li key={`${pair.contacts[0].id}:${pair.contacts[1].id}`}>
              <div className="merge-pair-row">
                <span
                  className={`merge-tier merge-tier-${pair.tier}`}
                  title={
                    pair.tier === 'strong'
                      ? 'Same email address — almost certainly one person'
                      : 'Same name, different emails — could be two real people'
                  }
                >
                  {pair.tier === 'strong' ? 'Same email' : 'Same name'}
                </span>
                <span className="merge-pair-names">
                  <strong>{nameOf(pair.contacts[0])}</strong>
                  <span className="detail-sub"> ({pair.contacts[0].email})</span>
                  {' ↔ '}
                  <strong>{nameOf(pair.contacts[1])}</strong>
                  <span className="detail-sub"> ({pair.contacts[1].email})</span>
                </span>
                <button type="button" onClick={() => setOpenPair(openPair === i ? null : i)}>
                  {openPair === i ? 'Close' : 'Review & merge'}
                </button>
              </div>
              {openPair === i && <MergePairEditor pair={pair} onMerged={afterMerge} />}
            </li>
          ))}
        </ul>
      )}
    </ModalDialog>
  )
}

/**
 * The side-by-side field picker for one candidate pair. The suggested winner
 * (server-ordered oldest-first, the 0015 survivor rule) leads, but the
 * organizer chooses which record survives; each conflicting field then gets a
 * keep-left/keep-right choice, defaulting to the winner's value.
 */
function MergePairEditor({ pair, onMerged }: { pair: DuplicatePair; onMerged: () => void }) {
  // Which of the pair survives — index into pair.contacts.
  const [winnerIdx, setWinnerIdx] = useState<0 | 1>(0)
  // Field picks keyed by field name, values as SIDES (0|1) so flipping the
  // winner never silently inverts the organizer's value choices.
  const [sidePicks, setSidePicks] = useState<Record<string, 0 | 1>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const winner = pair.contacts[winnerIdx]
  const loser = pair.contacts[winnerIdx === 0 ? 1 : 0]
  const conflicts = conflictingMergeFields(pair.contacts[0], pair.contacts[1])

  const run = async () => {
    if (pair.tier === 'weak') {
      // D2: a weak (name-only) match must be explicitly confirmed by a human —
      // the server does not distinguish tiers on the merge call, so the
      // confirmation lives here, in front of it.
      const confirmed = await appConfirm(
        `These records have different email addresses (${pair.contacts[0].email} and ${pair.contacts[1].email}) — they may be two real people who share a name. Merge them anyway?`,
        { title: 'Same name, different emails', confirmLabel: 'Merge anyway', danger: true },
      )
      if (!confirmed) return
    }
    setBusy(true)
    setError(null)
    try {
      const picks: Record<string, 'winner' | 'loser'> = {}
      for (const { field } of conflicts) {
        const side = sidePicks[field] ?? winnerIdx
        picks[field] = side === winnerIdx ? 'winner' : 'loser'
      }
      await mergeContacts(winner.id, loser.id, picks)
      onMerged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The merge failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="merge-editor">
      <div className="merge-keep-choice" role="radiogroup" aria-label="Record to keep">
        {([0, 1] as const).map((idx) => (
          <label key={pair.contacts[idx].id}>
            <input
              type="radio"
              name={`merge-winner-${pair.contacts[0].id}`}
              checked={winnerIdx === idx}
              onChange={() => setWinnerIdx(idx)}
            />
            <span>
              Keep <strong>{nameOf(pair.contacts[idx])}</strong>
              <span className="detail-sub"> · {pair.contacts[idx].email}</span>
              <span className="detail-sub">
                {' '}· on {pair.contacts[idx].event_count} event{pair.contacts[idx].event_count === 1 ? '' : 's'}
                {idx === 0 ? ' · older record' : ''}
              </span>
            </span>
          </label>
        ))}
      </div>

      {conflicts.length === 0 ? (
        <div className="settings-hint">
          No conflicting values — the kept record keeps its details, and any blanks fill in from the
          other record.
        </div>
      ) : (
        <table className="merge-fields">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">{nameOf(pair.contacts[0])}</th>
              <th scope="col">{nameOf(pair.contacts[1])}</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map(({ field, label }) => (
              <tr key={field}>
                <th scope="row">{label}</th>
                {([0, 1] as const).map((idx) => (
                  <td key={idx}>
                    <label>
                      <input
                        type="radio"
                        name={`merge-${pair.contacts[0].id}-${field}`}
                        checked={(sidePicks[field] ?? winnerIdx) === idx}
                        onChange={() => setSidePicks((prev) => ({ ...prev, [field]: idx }))}
                      />
                      <span>{String(pair.contacts[idx][field as keyof DuplicateContact] ?? '')}</span>
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <div className="settings-error" role="alert">{error}</div>}

      <div className="merge-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Merging…' : `Merge into ${nameOf(winner)}`}
        </button>
      </div>
    </div>
  )
}

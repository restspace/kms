import { useEffect, useState } from 'react'
import { getReviewLobby, type LobbyRow } from '../api'
import { navigate } from '../router'
import '../workspace/review.css'

/**
 * The lobby queue (workplan 15 W1b): "my top-ranked, not yet accepted" — the
 * per-human list a committee member lobbies from during the decision call.
 * Two surfaces, one shape: a panel on the reviewer screen and a collapsible
 * rail on the Submissions tab for staff who also review.
 *
 * The ordering is the caller's *own* score, not the committee mean, which is
 * why this reads a purpose-built endpoint rather than a sortable on the
 * submissions resource (D3).
 */

/** The rows themselves — the caller's own score leads each one, because that
 * is what the list is ordered by. */
export function LobbyList({ rows, onOpen }: { rows: LobbyRow[]; onOpen: (id: string) => void }) {
  return (
    <ul className="lobby-list">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)}>
            <span className="lobby-score">{r.my_score}</span>
            <span className="lobby-title">
              {r.code} — {r.title}
            </span>
            <span className="lobby-meta">
              mean {r.submission_rating ?? '—'} · {r.review_count} read{r.review_count === 1 ? '' : 's'}
              {r.track_name ? ` · ${r.track_name}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Fetch once per mount. A caller with no scores of their own gets an empty
 * list, and both surfaces below then render nothing at all — the organiser who
 * never reviews pays one request and sees no dead UI. */
function useLobby(): LobbyRow[] | null {
  const [rows, setRows] = useState<LobbyRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    getReviewLobby()
      .then((r) => {
        if (!cancelled) setRows(r.items)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  return rows
}

/** Each row opens the record through the existing `rec` permalink (router.ts)
 * — "the full proposal one keystroke away" is already satisfied once the queue
 * points at it. */
const openRecord = (id: string) => navigate({ v: 'workspace', tab: 'submissions', rec: id })

/** Submissions-tab rail: collapsed by default, since the grid is the primary
 * surface there and this is the lobbying aside. */
export function LobbyRail() {
  const rows = useLobby()
  if (!rows || rows.length === 0) return null
  return (
    <details className="lobby-rail">
      <summary>My top-ranked, not yet accepted ({rows.length})</summary>
      <LobbyList rows={rows} onOpen={openRecord} />
    </details>
  )
}

/** Reviewer-screen panel: open, because on that screen it is the point. */
export function LobbyPanel() {
  const rows = useLobby()
  if (!rows || rows.length === 0) return null
  return (
    <div className="lobby-panel">
      <div className="rq-head">My top-ranked, not yet accepted</div>
      <LobbyList rows={rows} onOpen={openRecord} />
    </div>
  )
}

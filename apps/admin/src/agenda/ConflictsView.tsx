import type { AgendaConflictRow, AgendaSessionRow } from '../api'

/**
 * Conflicts view (docs/07 §4): every detected conflict with resolve actions.
 * Ignored conflicts collapse into their own section and can be restored.
 */

const SEVERITY_ORDER: Array<AgendaConflictRow['severity']> = ['error', 'warning', 'info']

const SEVERITY_LABEL: Record<AgendaConflictRow['severity'], string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
}

interface ConflictsViewProps {
  conflicts: AgendaConflictRow[]
  sessionById: Map<string, AgendaSessionRow>
  onOpenMove: (sessionId: string) => void
  onRemoveSpeaker: (sessionId: string, contactId: string, speakerName: string, sessionTitle: string) => void
  onIgnore: (signature: string, ignored: boolean) => void
}

export function ConflictsView({ conflicts, sessionById, onOpenMove, onRemoveSpeaker, onIgnore }: ConflictsViewProps) {
  const live = conflicts.filter((c) => !c.ignored)
  const ignored = conflicts.filter((c) => c.ignored)

  const row = (c: AgendaConflictRow, isIgnored: boolean) => {
    const involved = c.session_ids
      .map((id) => sessionById.get(id))
      .filter((s): s is AgendaSessionRow => s !== undefined)
    const speaker =
      c.contact_id !== undefined
        ? involved.flatMap((s) => s.speakers).find((sp) => sp.contact_id === c.contact_id)
        : undefined
    return (
      <div className={`conflict-row sev-${c.severity}`} key={c.signature}>
        <span className="conflict-dot" aria-hidden />
        <div className="conflict-main">
          <div className="conflict-code-line">
            <code>{c.code}</code>
            <span className={`conflict-sev sev-${c.severity}`}>{c.severity}</span>
          </div>
          <p>{c.message}</p>
          <div className="conflict-involved">
            {involved.map((s) => (
              <button className="conflict-session-link" key={s.id} onClick={() => onOpenMove(s.id)} title="Open the Move dialog">
                {s.code} · {s.title}
              </button>
            ))}
          </div>
        </div>
        <div className="conflict-actions">
          {!isIgnored && involved.length > 0 && (
            <>
              <button onClick={() => onOpenMove((involved[0] as AgendaSessionRow).id)}>Move session</button>
              <button onClick={() => onOpenMove((involved[involved.length - 1] as AgendaSessionRow).id)}>
                Change room
              </button>
            </>
          )}
          {!isIgnored && speaker && c.contact_id && involved.length > 0 && (
            <button
              onClick={() => {
                const target = involved[involved.length - 1] as AgendaSessionRow
                onRemoveSpeaker(target.id, c.contact_id as string, speaker.name, target.title)
              }}
            >
              Remove speaker
            </button>
          )}
          <button onClick={() => onIgnore(c.signature, !isIgnored)}>
            {isIgnored ? 'Restore' : 'Ignore'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="conflicts-view">
      {live.length === 0 && <p className="conflicts-empty">No conflicts — the schedule is clean. 🎉</p>}
      {SEVERITY_ORDER.map((sev) => {
        const group = live.filter((c) => c.severity === sev)
        if (group.length === 0) return null
        return (
          <section key={sev}>
            <h3 className={`conflict-group-head sev-${sev}`}>
              {SEVERITY_LABEL[sev]} <span>({group.length})</span>
            </h3>
            {group.map((c) => row(c, false))}
          </section>
        )
      })}
      {ignored.length > 0 && (
        <details className="conflicts-ignored">
          <summary>Ignored ({ignored.length})</summary>
          {ignored.map((c) => row(c, true))}
        </details>
      )}
    </div>
  )
}

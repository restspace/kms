import { useEffect, useRef, useState } from 'react'
import { ModalDialog } from '../components/dialogs'
import { composeMessage } from '../api'
import { describeRunningJob, describeSettledJob, pollBulkJob, type BulkJobPollHandle } from './messaging'

/**
 * Eval defect #15: the org directory grid had no checkbox multi-select at
 * all — bulk email only reached the audience-preset paths (SPK-13's compose
 * form), never "I picked these specific N people off the grid". The grid
 * side is DataList/DataTabManager's existing `onChecklist` + toolbarActions
 * machinery (already used by the Submissions tab's "↓ FILES" button); this
 * is the other half, opened from a "Message selected (N)" toolbar action.
 *
 * Deliberately its own small dialog rather than reusing SPK-13's `ComposeForm`
 * (workspace/messaging.tsx): that form owns audience presets and the template
 * picker, live surfaces under active work elsewhere. This sends through the
 * exact same seam instead — `composeMessage` with `audience: 'selected'`,
 * the same `pollBulkJob`/`describeSettledJob` progress reporting — so a
 * checkbox-driven send is indistinguishable, server-side and in the Messages
 * tab afterwards, from one launched through the compose form's own "Choose
 * recipients…" picker. Opened imperatively (the `openContactPicker` /
 * `openImportWizard` pattern) because its entry point is a toolbarAction
 * inside `buildWorkspaceConfig`, plain data with nowhere to hang React state.
 */

export interface MessageSelectedRequest {
  contactIds: string[]
  /** Called once the send settles (sent or failed), so a caller tracking its
   * own "just sent" banner can react; the grid itself needs no refetch. */
  onSent?: () => void
}

let enqueue: ((request: MessageSelectedRequest) => void) | null = null
const pending: MessageSelectedRequest[] = []

/** Opens the "message selected contacts" dialog. */
export function openMessageSelectedDialog(request: MessageSelectedRequest): void {
  if (enqueue) enqueue(request)
  else pending.push(request)
}

/** Renders once at the app root; services `openMessageSelectedDialog` requests. */
export function MessageSelectedHost() {
  const [queue, setQueue] = useState<MessageSelectedRequest[]>([])
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
    <MessageSelectedDialog key={queue.length} request={current} onClose={() => setQueue((q) => q.slice(1))} />
  )
}

type Phase =
  | { kind: 'editing' }
  | { kind: 'sending'; note: string }
  | { kind: 'settled'; note: string; failed: boolean }

function MessageSelectedDialog({ request, onClose }: { request: MessageSelectedRequest; onClose: () => void }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('Hi {{first_name}},\n\n')
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' })
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<BulkJobPollHandle | null>(null)
  useEffect(() => () => pollRef.current?.cancel(), [])

  const count = request.contactIds.length

  const send = async () => {
    setError(null)
    if (!subject.trim()) return setError('A subject is required.')
    if (!body.trim()) return setError('The message body is empty.')
    setPhase({ kind: 'sending', note: 'Queueing…' })
    try {
      const r = await composeMessage({
        subject: subject.trim(),
        body: body.trim(),
        audience: 'selected',
        contact_ids: request.contactIds,
      })
      setPhase({ kind: 'sending', note: `Queued for ${r.total} recipient${r.total === 1 ? '' : 's'}…` })
      pollRef.current = pollBulkJob(r.job_id, {
        onProgress: (job) => setPhase({ kind: 'sending', note: describeRunningJob(job, 'message') }),
        onSettled: (job) => {
          setPhase({ kind: 'settled', note: describeSettledJob(job, 'message'), failed: job.status === 'failed' })
          request.onSent?.()
        },
        onError: (message) => setPhase({ kind: 'settled', note: message, failed: true }),
      })
    } catch (err) {
      setPhase({ kind: 'editing' })
      setError(err instanceof Error ? err.message : 'The message could not be queued.')
    }
  }

  const close = () => {
    pollRef.current?.cancel()
    onClose()
  }

  return (
    <ModalDialog
      open
      width="md"
      title={`Message ${count} selected contact${count === 1 ? '' : 's'}`}
      onClose={close}
      footer={
        phase.kind === 'editing' ? (
          <>
            <button onClick={close}>Cancel</button>
            <button className="primary" onClick={() => void send()}>
              Send to {count}
            </button>
          </>
        ) : (
          <button className="primary" onClick={close}>Close</button>
        )
      }
    >
      {phase.kind === 'editing' ? (
        <div className="record-form-fields">
          {error && <div className="record-form-submit-error" role="alert">{error}</div>}
          <div className="record-form-field">
            <label htmlFor="message-selected-subject">Subject</label>
            <input
              id="message-selected-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject((e.target as HTMLInputElement).value)}
            />
          </div>
          <div className="record-form-field">
            <label htmlFor="message-selected-body">Message</label>
            <textarea
              id="message-selected-body"
              rows={10}
              value={body}
              onChange={(e) => setBody((e.target as HTMLTextAreaElement).value)}
            />
            <p className="record-form-help">
              Merge fields like <code>{'{{first_name}}'}</code>, <code>{'{{company}}'}</code> and{' '}
              <code>{'{{event.name}}'}</code> are filled in per recipient. Line breaks are kept; HTML is not
              interpreted.
            </p>
          </div>
        </div>
      ) : (
        <p role="status" className={phase.kind === 'settled' && phase.failed ? 'compose-note-error' : undefined}>
          {phase.note}
        </p>
      )}
      {phase.kind === 'sending' && (
        <p className="record-form-help">
          You can close this now — the send continues in the background, and the Messages tab will show each
          recipient's delivery status as it lands.
        </p>
      )}
    </ModalDialog>
  )
}

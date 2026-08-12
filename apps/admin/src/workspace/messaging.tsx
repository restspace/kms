import { useEffect, useRef, useState } from 'react'
import {
  composeMessage,
  getBulkJob,
  getComposeAudiences,
  invitePortal,
  queryResource,
  retryMessage,
  type BulkJobStatus,
  type ComposeAudience,
  type ComposeAudienceCount,
  type ContactRow,
  type MergeField,
  type MessageRow,
} from '../api'
import type { CreateFormProps } from '../components/DataTabManager'

/**
 * Organiser-side messaging UI (SPK-06 / SPK-13).
 *
 * Both surfaces here send through the same server seam every other email
 * uses, so their outcome is visible in the Messages tab (message_log) rather
 * than only in a toast: the portal invite is one `magic_link` send, and a
 * compose is a `bulk_jobs` snapshot the cron expander renders per recipient.
 * Neither reports "sent" from what it *asked for* — the compose flow polls
 * `GET /app/api/bulk-jobs/:id` for the counts message_log actually recorded
 * (the CFP-14 lesson, applied from the start).
 */

// ---------------------------------------------------------------------------
// Shared bulk-job polling
// ---------------------------------------------------------------------------

export interface BulkJobPollHandle {
  cancel: () => void
}

/**
 * Poll a bulk job to a settled state, reporting progress as it goes. Factored
 * out of DashboardSection's `pollRemindJob` shape so every caller that fires a
 * 202-style bulk send (decisions, compose, …) reports the same way: real
 * sent/failed counts from message_log, never the planned counts the POST
 * echoed back.
 *
 * Returns a handle whose `cancel()` stops the loop and suppresses both
 * callbacks — call it from an unmount effect.
 */
export function pollBulkJob(
  jobId: string,
  handlers: {
    onProgress?: (job: BulkJobStatus) => void
    onSettled: (job: BulkJobStatus) => void
    onError: (message: string) => void
  },
  intervalMs = 3_000,
): BulkJobPollHandle {
  let cancelled = false
  let timer: number | null = null

  const tick = async () => {
    if (cancelled) return
    try {
      const job = await getBulkJob(jobId)
      if (cancelled) return
      if (job.status === 'done' || job.status === 'failed') {
        handlers.onSettled(job)
        return
      }
      handlers.onProgress?.(job)
      timer = window.setTimeout(() => void tick(), intervalMs)
    } catch (err) {
      if (cancelled) return
      handlers.onError(err instanceof Error ? err.message : 'Could not check progress')
    }
  }

  void tick()
  return {
    cancel: () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    },
  }
}

/** "12 sent, 1 failed" / "nothing sent" — the settled wording, shared. */
export function describeSettledJob(job: BulkJobStatus, noun: string): string {
  if (job.status === 'failed') return job.error ?? `Sending ${noun}s failed.`
  // Full accounting (2026-08-12 eval sweep, defects 2/3/4): every recipient
  // the button counted must be accounted for in this line — sent, failed,
  // still queued, or skipped with a reason — so the confirmation can never
  // silently disagree with the "Send to N" it followed.
  const skippedParts: string[] = []
  if ((job.skipped_duplicate ?? 0) > 0) skippedParts.push(`${job.skipped_duplicate} skipped (already sent)`)
  if ((job.skipped_no_email ?? 0) > 0) skippedParts.push(`${job.skipped_no_email} skipped (no email address)`)
  const skippedTail = skippedParts.length > 0 ? `, ${skippedParts.join(', ')}` : ''
  if (job.sent === 0 && job.failed === 0) {
    // "No emails were sent" is only true when nothing was ever queued. A job
    // can settle with messages still in the outbox (delivery retrying, or a
    // tick that queued without delivering inline) — claiming nothing was sent
    // there directly contradicted the Notified stamps the same run set.
    const queued = job.queued ?? 0
    if (queued > 0) return `${queued} ${noun}${queued === 1 ? '' : 's'} queued — delivery in progress${skippedTail}.`
    if (skippedParts.length > 0) return `No new ${noun}s were sent — ${skippedParts.join(', ')}.`
    return `No ${noun}s were sent.`
  }
  const sent = `${job.sent} ${noun}${job.sent === 1 ? '' : 's'} sent`
  const stillQueued = job.queued ?? 0
  const tail = (stillQueued > 0 ? `, ${stillQueued} still queued` : '') + skippedTail
  return job.failed > 0 ? `${sent}, ${job.failed} failed${tail}.` : `${sent}${tail}.`
}

/** "Sending… 20/50 queued." — the in-flight wording, shared. */
export function describeRunningJob(job: BulkJobStatus, noun: string): string {
  return `Sending ${noun}s… ${job.enqueued}/${job.total ?? '?'} queued.`
}

// ---------------------------------------------------------------------------
// SPK-06: invite a contact to their speaker portal
// ---------------------------------------------------------------------------

/**
 * "Invite to portal" on the speaker detail panel. The organiser had no way to
 * get a known contact into the portal short of asking them to run the
 * public sign-in flow themselves.
 *
 * `duplicate` is a real answer, not an error: the server keys the send on the
 * freshly minted token, so it only comes back if the very same invite is
 * already queued — say the button was double-clicked.
 */
export function PortalInviteButton({ contactId, contactName }: { contactId: string; contactName: string }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  // The actual minted link, so an organiser can verify/share/impersonate
  // through it without needing the speaker's inbox — same contract as the
  // reviewer sign-in link panel in EvaluationSection.
  const [link, setLink] = useState<string | null>(null)
  const linkInputRef = useRef<HTMLInputElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])

  const invite = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await invitePortal(contactId)
      if (!mounted.current) return
      setLink(r.link)
      setNote(
        r.outcome === 'template_disabled'
          ? { tone: 'error', text: 'The sign-in email template is disabled for this event — nothing was sent.' }
          : r.outcome === 'duplicate'
            ? { tone: 'ok', text: 'That invitation is already queued.' }
            : { tone: 'ok', text: `Invitation queued — see the Messages tab for delivery status.` },
      )
    } catch (err) {
      if (!mounted.current) return
      setNote({ tone: 'error', text: err instanceof Error ? err.message : 'The invitation could not be sent.' })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void invite()} title={`Email ${contactName} a sign-in link for their speaker portal`}>
        {busy ? 'Inviting…' : 'Invite to portal'}
      </button>
      {note && (
        <span role="status" className={note.tone === 'error' ? 'compose-note-error' : 'compose-note-ok'}>
          {note.text}
        </span>
      )}
      {link && (
        <div role="status" style={{ display: 'grid', gap: 4, margin: '6px 0', fontSize: 12 }}>
          <strong>Portal sign-in link for {contactName}</strong>
          <span className="pane-sub">
            Valid for 15 minutes, single use. Open it yourself to preview the portal as {contactName}, or copy it
            to verify/share the invite without waiting on their inbox.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={linkInputRef}
              readOnly
              aria-label={`Portal sign-in link for ${contactName}`}
              value={link}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              type="button"
              onClick={() => {
                // Clipboard writes can be refused (headless runs, an
                // unfocused/insecure context, or the API being absent
                // entirely) — that's not an error the organiser caused or can
                // fix, so fall back to selecting the text for Ctrl+C.
                const selectInstead = () => {
                  const el = linkInputRef.current
                  el?.focus()
                  el?.select()
                  setNote({ tone: 'ok', text: 'Press Ctrl+C (Cmd+C) to copy — the link is selected.' })
                }
                let attempt: Promise<void> | undefined
                try {
                  attempt = navigator.clipboard?.writeText(link)
                } catch {
                  attempt = undefined
                }
                if (!attempt) {
                  selectInstead()
                  return
                }
                void attempt.then(() => setNote({ tone: 'ok', text: 'Copied the portal sign-in link.' }), selectInstead)
              }}
            >
              Copy
            </button>
            <button type="button" onClick={() => setLink(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Messages tab: detail panel (rendered content + retry)
// ---------------------------------------------------------------------------

/**
 * Detail panel for one message_log row (2026-08-12 eval sweep, defects 3/5).
 *
 * Previously this showed only metadata (To / Queued / Sent), so an organiser
 * could never verify what was actually sent or whether merge fields resolved.
 * The rendered per-recipient body has been persisted on the row since
 * migration 0029 — show the text rendering (exactly what the provider's
 * plain-text part carried, merge fields resolved), with the HTML source one
 * disclosure away. Rows queued before 0029 have no stored body; say so
 * instead of pretending.
 *
 * A 'failed' row also gets a Retry button: it revives the dead outbox row
 * (or rebuilds it from the stored body) and attempts delivery inline, so the
 * outcome shown here is the real one.
 */
export function MessageDetailPanel({ item }: { item: MessageRow }) {
  const [row, setRow] = useState(item)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    setRow(item)
    setNote(null)
  }, [item])

  const retry = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await retryMessage(item.id)
      setRow((prev) => ({ ...prev, status: r.status, error: r.error, sent_at: r.sent_at }))
      setNote(
        r.status === 'sent'
          ? { tone: 'ok', text: 'Delivered.' }
          : r.status === 'queued'
            ? { tone: 'ok', text: 'Re-queued — delivery will be retried shortly.' }
            : { tone: 'error', text: r.error ?? 'The retry did not succeed.' },
      )
    } catch (err) {
      setNote({ tone: 'error', text: err instanceof Error ? err.message : 'The message could not be retried.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="detail-panel">
      <h2>{row.subject ?? '(no subject)'}</h2>
      <div className="detail-sub">
        {row.template_key} · <span className={`status-chip status-${row.status}`}>{row.status}</span>
      </div>
      <dl>
        <dt>To</dt><dd>{row.contact_name ? `${row.contact_name} <${row.to_email}>` : row.to_email}</dd>
        <dt>Queued</dt><dd>{new Date(row.created_at).toLocaleString()}</dd>
        {row.sent_at && <><dt>Sent</dt><dd>{new Date(row.sent_at).toLocaleString()}</dd></>}
        {row.error && <><dt>Error</dt><dd>{row.error}</dd></>}
      </dl>
      {row.status === 'failed' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
          <button type="button" disabled={busy} onClick={() => void retry()}>
            {busy ? 'Retrying…' : 'Retry send'}
          </button>
          {note && (
            <span role="status" className={note.tone === 'error' ? 'compose-note-error' : 'compose-note-ok'}>
              {note.text}
            </span>
          )}
        </div>
      )}
      {row.status !== 'failed' && note && (
        <p role="status" className={note.tone === 'error' ? 'compose-note-error' : 'compose-note-ok'}>{note.text}</p>
      )}
      <h3 style={{ marginTop: 12 }}>Message body</h3>
      {row.body_text || row.body_html ? (
        <>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontFamily: 'inherit',
              fontSize: 13,
              background: 'rgba(127, 127, 127, 0.08)',
              padding: 10,
              borderRadius: 6,
              maxHeight: 360,
              overflow: 'auto',
            }}
          >
            {row.body_text ?? row.body_html}
          </pre>
          {row.body_html && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12 }}>HTML source</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, maxHeight: 240, overflow: 'auto' }}>
                {row.body_html}
              </pre>
            </details>
          )}
        </>
      ) : (
        <p className="pane-sub">
          The rendered body was not recorded for this message (it was queued before body logging was added).
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SPK-13: compose
// ---------------------------------------------------------------------------

const AUDIENCE_LABELS: Record<Exclude<ComposeAudience, 'selected'>, string> = {
  all_contacts: 'Everyone on this event',
  speakers: 'Speakers (anyone attached to a submission)',
  accepted_speakers: 'Accepted speakers',
}

type ComposePhase =
  | { kind: 'editing' }
  | { kind: 'sending'; note: string }
  | { kind: 'settled'; note: string; failed: boolean }

/**
 * Compose form, wired as the Messages tab's `createComponent` (the same
 * mechanism the Tasks tab uses for TaskCreateForm — it opens "+ New" without
 * also turning message rows into editable records).
 *
 * Recipient selection has two shapes: a named audience the server resolves
 * (counts come from `/compose/audiences` so the option labels are honest), or
 * an explicit multi-select of contacts. Either way resolution happens
 * server-side and is frozen into the job, so what the organiser sees in the
 * confirm line is what the expander will send to.
 *
 * The body is a plain textarea by design — merge fields are substituted
 * server-side per recipient by the same render engine that drives every
 * system template, so `{{first_name}}` is the extent of the markup an
 * organiser needs.
 */
export function ComposeForm({ onSubmit, onCancel, title }: CreateFormProps) {
  const [audience, setAudience] = useState<ComposeAudience>('speakers')
  const [counts, setCounts] = useState<ComposeAudienceCount[] | null>(null)
  const [mergeFields, setMergeFields] = useState<MergeField[]>([])
  const [contacts, setContacts] = useState<ContactRow[] | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('Hi {{first_name}},\n\n')
  const [phase, setPhase] = useState<ComposePhase>({ kind: 'editing' })
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<BulkJobPollHandle | null>(null)

  useEffect(() => () => pollRef.current?.cancel(), [])

  useEffect(() => {
    getComposeAudiences()
      .then((r) => {
        setCounts(r.items)
        setMergeFields(r.merge_fields)
      })
      .catch(() => setCounts([]))
  }, [])

  // The contact list is only fetched when the organiser actually picks
  // "Choose recipients" — most sends use a named audience and never need it.
  useEffect(() => {
    if (audience !== 'selected' || contacts !== null) return
    queryResource<ContactRow>('contacts')({ from: 0, size: 500, filters: {} })
      .then((r) => setContacts(r.items))
      .catch(() => setContacts([]))
  }, [audience, contacts])

  const countFor = (key: Exclude<ComposeAudience, 'selected'>): number | null =>
    counts?.find((c) => c.audience === key)?.count ?? null

  const recipientCount = audience === 'selected' ? selectedIds.length : countFor(audience)

  const send = async () => {
    setError(null)
    if (!subject.trim()) return setError('A subject is required.')
    if (!body.trim()) return setError('The message body is empty.')
    if (audience === 'selected' && selectedIds.length === 0) return setError('Pick at least one recipient.')

    setPhase({ kind: 'sending', note: 'Queueing…' })
    try {
      const r = await composeMessage({
        subject: subject.trim(),
        body: body.trim(),
        audience,
        ...(audience === 'selected' ? { contact_ids: selectedIds } : {}),
      })
      setPhase({ kind: 'sending', note: `Queued for ${r.total} recipient${r.total === 1 ? '' : 's'}…` })
      pollRef.current = pollBulkJob(r.job_id, {
        onProgress: (job) => setPhase({ kind: 'sending', note: describeRunningJob(job, 'message') }),
        onSettled: (job) =>
          setPhase({ kind: 'settled', note: describeSettledJob(job, 'message'), failed: job.status === 'failed' }),
        onError: (message) => setPhase({ kind: 'settled', note: message, failed: true }),
      })
    } catch (err) {
      setPhase({ kind: 'editing' })
      setError(err instanceof Error ? err.message : 'The message could not be queued.')
    }
  }

  if (phase.kind !== 'editing') {
    return (
      <div className="record-form compose-form">
        <div className="record-form-header">
          <h2>{title}</h2>
        </div>
        <div className="record-form-fields">
          <p role="status" className={phase.kind === 'settled' && phase.failed ? 'compose-note-error' : undefined}>
            {phase.note}
          </p>
          {phase.kind === 'settled' && (
            <p className="record-form-help">
              Every recipient has a row in the Messages tab with its own delivery status.
            </p>
          )}
          {phase.kind === 'sending' && (
            <p className="record-form-help">
              You can close this now — the send continues in the background and the Messages tab will show
              each recipient's delivery status as it lands.
            </p>
          )}
        </div>
        <div className="record-form-actions">
          <span className="record-form-actions-spacer" />
          <button
            type="button"
            className="record-form-submit"
            onClick={() => {
              // Closing mid-send never needs to block: the compose job already
              // exists server-side and keeps draining on the cron sweep
              // regardless of whether this dialog is still polling it. Cancel
              // the poll so it doesn't keep ticking against an unmounted
              // caller's state, then close immediately — previously Close was
              // disabled for the whole 'sending' phase, which could pin the
              // dialog open for up to a full cron tick (~60s) with no way out.
              pollRef.current?.cancel()
              void onSubmit({})
            }}
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="record-form compose-form"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      noValidate
    >
      <div className="record-form-header">
        <h2>{title}</h2>
      </div>
      {error && <div className="record-form-submit-error" role="alert">{error}</div>}
      <div className="record-form-fields">
        <div className="record-form-field">
          <label htmlFor="compose-audience">Recipients</label>
          <select
            id="compose-audience"
            value={audience}
            onChange={(e) => setAudience((e.target as HTMLSelectElement).value as ComposeAudience)}
          >
            {(Object.keys(AUDIENCE_LABELS) as Array<Exclude<ComposeAudience, 'selected'>>).map((key) => {
              const n = countFor(key)
              return (
                <option key={key} value={key}>
                  {AUDIENCE_LABELS[key]}{n === null ? '' : ` — ${n}`}
                </option>
              )
            })}
            <option value="selected">Choose recipients…</option>
          </select>
        </div>

        {audience === 'selected' && (
          <div className="record-form-field">
            <label htmlFor="compose-contacts">Contacts</label>
            {contacts === null ? (
              <p className="record-form-help">Loading contacts…</p>
            ) : (
              <select
                id="compose-contacts"
                multiple
                size={8}
                value={selectedIds}
                onChange={(e) => {
                  const el = e.target as HTMLSelectElement
                  setSelectedIds(Array.from(el.selectedOptions, (o) => o.value))
                }}
              >
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email} — {c.email}
                  </option>
                ))}
              </select>
            )}
            <p className="record-form-help">Ctrl/Cmd-click to pick more than one.</p>
          </div>
        )}

        <div className="record-form-field">
          <label htmlFor="compose-subject">Subject</label>
          <input
            id="compose-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject((e.target as HTMLInputElement).value)}
          />
        </div>

        <div className="record-form-field">
          <label htmlFor="compose-body">Message</label>
          <textarea
            id="compose-body"
            rows={12}
            value={body}
            onChange={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          />
          <p className="record-form-help">
            Merge fields are filled in per recipient:{' '}
            {mergeFields.map((f, i) => (
              <span key={f.field}>
                {i > 0 && ', '}
                <code title={f.description}>{`{{${f.field}}}`}</code>
              </span>
            ))}
            . Line breaks are kept; HTML is not interpreted.
          </p>
        </div>
      </div>
      <div className="record-form-actions">
        <span className="record-form-actions-spacer" />
        <button type="button" className="record-form-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="record-form-submit">
          Send{recipientCount !== null ? ` to ${recipientCount}` : ''}
        </button>
      </div>
    </form>
  )
}

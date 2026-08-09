import { useCallback, useEffect, useState } from 'react'
import {
  addFileComment,
  getFileChain,
  getFileLibrary,
  getTaskAssignmentFiles,
  type FileChain,
  type FileComment,
  type FileLibraryRow,
  type FileVersion,
} from '../api'
import './files.css'

/**
 * Organiser-side file surfaces (lane W2-C).
 *
 * Before this, a speaker could complete a file-request task and the uploaded
 * bytes were invisible everywhere in the admin app: no filename, no link. These
 * panels render the same version chain and the same comment thread the speaker
 * portal shows, so a reply here lands in the conversation they already see.
 *
 * Everything downloads through `/files/:id`, which applies the record-level ACL
 * (fileAuth.ts) — the admin app never proxies bytes itself.
 */

export const formatBytes = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
}

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

/** Newest first; every version keeps its own download link. */
export function FileVersionList({ versions }: { versions: FileVersion[] }) {
  if (versions.length === 0) return null
  const ordered = [...versions].sort((a, b) => b.version - a.version)
  return (
    <ul className="file-versions">
      {ordered.map((v) => (
        <li key={v.file_asset_id}>
          <a href={`/files/${v.file_asset_id}`} target="_blank" rel="noopener">
            {v.filename}
          </a>
          <span className={v.is_current === 1 ? 'file-vtag current' : 'file-vtag'}>
            v{v.version}
            {v.is_current === 1 ? ' · Current' : ''}
          </span>
          <span className="file-vmeta">
            {formatBytes(v.size_bytes)} · {fmtDateTime(v.uploaded_at)}
            {v.uploader_name || v.uploader_email ? ` · ${v.uploader_name ?? v.uploader_email}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The thread for a chain. Comments are anchored to the version they were left
 * on (shown as "on v1") but stay in one conversation across re-uploads, so an
 * organiser's reply sits under the speaker's note rather than in a new thread.
 * Replies attach to the current version — the one the reply is about.
 */
export function FileThread({
  versions,
  comments,
  onComments,
}: {
  versions: FileVersion[]
  comments: FileComment[]
  onComments: (next: FileComment[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = versions.find((v) => v.is_current === 1) ?? versions[versions.length - 1]
  const multi = versions.length > 1
  // A file_upload task with no file request has no upload row to hang comments
  // on (the asset only exists via task_assignments.response_id).
  const canReply = Boolean(current && current.upload_id)

  const post = async () => {
    if (!current || draft.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await addFileComment(current.upload_id, draft.trim())
      onComments(res.comments)
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to post comment')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="file-thread">
      <strong style={{ fontSize: 13 }}>Comments</strong>
      {comments.length === 0 && <p className="file-empty">No comments yet.</p>}
      {comments.map((m) => (
        <div key={m.id} className={m.author_role === 'speaker' ? 'file-comment speaker' : 'file-comment'}>
          <div className="fc-head">
            <strong>{m.author_name ?? 'Someone'}</strong>
            {m.author_role === 'speaker' ? ' · Speaker' : ' · Organiser'} · {fmtDateTime(m.created_at)}
            {multi ? ` · on v${m.version}` : ''}
          </div>
          <div className="fc-body">{m.body}</div>
        </div>
      ))}
      {canReply && (
        <div className="file-reply">
          <textarea
            rows={2}
            value={draft}
            aria-label="Reply to the file thread"
            placeholder="Reply to the speaker…"
            onChange={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          />
          <div className="file-reply-actions">
            <button type="button" disabled={busy || draft.trim() === ''} onClick={() => void post()}>
              {busy ? 'Posting…' : 'Reply'}
            </button>
            {error && <span className="file-error" role="alert">{error}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Version list + thread for one chain, with local thread state. */
export function FileChainPanel({ chain, heading }: { chain: FileChain; heading?: string }) {
  const [comments, setComments] = useState<FileComment[]>(chain.comments)
  useEffect(() => setComments(chain.comments), [chain])
  if (chain.versions.length === 0) return null
  const current = chain.versions.find((v) => v.is_current === 1) ?? chain.versions[chain.versions.length - 1]
  return (
    <div className="file-chain">
      <div className="file-chain-head">
        <span className="fname">{heading ?? current?.filename}</span>
        <span className="file-vtag">
          {chain.versions.length} version{chain.versions.length === 1 ? '' : 's'}
        </span>
      </div>
      <FileVersionList versions={chain.versions} />
      <FileThread versions={chain.versions} comments={comments} onComments={setComments} />
    </div>
  )
}

/**
 * Tasks tab: a completed file_upload assignment shows what was uploaded.
 * Manual-QA item (a) — organisers could see the task flip to complete but never
 * the file it produced.
 */
export function TaskFilesPanel({ assignmentId, actionType }: { assignmentId: string; actionType: string }) {
  const [chain, setChain] = useState<FileChain | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (actionType !== 'file_upload') return
    setChain(null)
    setError(null)
    getTaskAssignmentFiles(assignmentId)
      .then(setChain)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load files'))
  }, [assignmentId, actionType])

  if (actionType !== 'file_upload') return null
  return (
    <>
      <h2 style={{ fontSize: 14, marginTop: 16 }}>Uploaded file</h2>
      {error && <p className="file-error">{error}</p>}
      {!chain && !error && <p className="file-empty">Loading…</p>}
      {chain && chain.versions.length === 0 && <p className="file-empty">Nothing uploaded yet.</p>}
      {chain && chain.versions.length > 0 && <FileChainPanel chain={chain} />}
    </>
  )
}

/**
 * Submission detail: every upload scoped to this submission (slides and the
 * like), one block per chain. Manual-QA item (b).
 */
export function SubmissionFilesPanel({ submissionId }: { submissionId: string }) {
  const [rows, setRows] = useState<FileLibraryRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [chain, setChain] = useState<FileChain | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRows(null)
    setOpen(null)
    setChain(null)
    getFileLibrary({ submission_id: submissionId, size: 50 })
      .then((r) => setRows(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load files'))
  }, [submissionId])

  const toggle = useCallback((uploadId: string) => {
    setOpen((prev) => (prev === uploadId ? null : uploadId))
    setChain(null)
    getFileChain(uploadId)
      .then(setChain)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load versions'))
  }, [])

  return (
    <>
      <h2 style={{ fontSize: 14, marginTop: 16 }}>
        Files{rows && rows.length > 0 ? ` (${rows.length})` : ''}
      </h2>
      {error && <p className="file-error">{error}</p>}
      {!rows && !error && <p className="file-empty">Loading…</p>}
      {rows && rows.length === 0 && <p className="file-empty">No files uploaded for this submission.</p>}
      {rows?.map((r) => (
        <div className="file-chain" key={r.upload_id}>
          <div className="file-chain-head">
            <a className="fname" href={`/files/${r.file_asset_id}`} target="_blank" rel="noopener">
              {r.filename}
            </a>
            <span className="file-vtag current">v{r.version} · Current</span>
            <button type="button" onClick={() => toggle(r.upload_id)}>
              {open === r.upload_id ? 'Hide' : `Versions & comments (${r.version_count}/${r.comment_count})`}
            </button>
            <span className="file-vmeta">
              {formatBytes(r.size_bytes)} · {r.uploader_name ?? r.uploader_email ?? 'Unknown'} ·{' '}
              {fmtDateTime(r.uploaded_at)}
            </span>
          </div>
          {open === r.upload_id && chain && <FileChainPanel chain={chain} heading={r.filename} />}
          {open === r.upload_id && !chain && <p className="file-empty">Loading…</p>}
        </div>
      ))}
    </>
  )
}

/** Files library tab: the detail panel behind a library row. */
export function FileLibraryDetail({ item }: { item: FileLibraryRow }) {
  const [chain, setChain] = useState<FileChain | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setChain(null)
    setError(null)
    getFileChain(item.upload_id)
      .then(setChain)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load versions'))
  }, [item.upload_id])

  return (
    <div className="detail-panel">
      <h2>{item.filename}</h2>
      <div className="detail-sub">
        {item.request_title ?? 'Upload'}
        {item.submission_code ? ` · ${item.submission_code} — ${item.submission_title ?? ''}` : ''}
      </div>
      <dl>
        <div style={{ display: 'contents' }}>
          <dt>Uploaded by</dt>
          <dd>{item.uploader_name ?? item.uploader_email ?? 'Unknown'}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Size</dt>
          <dd>{formatBytes(item.size_bytes)}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Type</dt>
          <dd>{item.content_type ?? '—'}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Latest upload</dt>
          <dd>{fmtDateTime(item.uploaded_at)}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Versions</dt>
          <dd>{item.version_count}</dd>
        </div>
      </dl>
      {error && <p className="file-error">{error}</p>}
      {!chain && !error && <p className="file-empty">Loading…</p>}
      {chain && <FileChainPanel chain={chain} heading={item.filename} />}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addFileComment,
  getFileChain,
  getFileLibrary,
  getTaskAssignmentFiles,
  uploadOrganiserFile,
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

/**
 * One attribution rule for every surface (eval defect: the library row said
 * "Uploaded by James" while the detail page said "Uploaded by Priya"): prefer
 * who actually performed the upload (file_assets.uploaded_by_contact_id),
 * fall back to the chain's contact for older rows / self-service uploads
 * where the two are the same person.
 */
export const uploadedByLabel = (
  v: Pick<FileVersion, 'uploader_name' | 'uploader_email' | 'uploaded_by_name' | 'uploaded_by_email'>,
): string | null => v.uploaded_by_name ?? v.uploaded_by_email ?? v.uploader_name ?? v.uploader_email ?? null

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
            {uploadedByLabel(v) ? ` · ${uploadedByLabel(v)}` : ''}
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
  // Organiser upload control (eval defect: this section was read-only, so an
  // organiser could not add or replace a deliverable on a speaker's behalf).
  // One hidden file input serves both "Upload file" (new chain) and each
  // chain's "New version" button; the ref records which chain, if any.
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const versionTargetRef = useRef<string | null>(null)

  const reload = useCallback(
    () =>
      getFileLibrary({ submission_id: submissionId, size: 50 })
        .then((r) => setRows(r.items))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load files')),
    [submissionId],
  )

  useEffect(() => {
    setRows(null)
    setOpen(null)
    setChain(null)
    setUploadNote(null)
    void reload()
  }, [reload])

  const toggle = useCallback((uploadId: string) => {
    setOpen((prev) => (prev === uploadId ? null : uploadId))
    setChain(null)
    getFileChain(uploadId)
      .then(setChain)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load versions'))
  }, [])

  const pickFile = (uploadId: string | null) => {
    versionTargetRef.current = uploadId
    fileInputRef.current?.click()
  }

  const onFilePicked = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const target = versionTargetRef.current
    setUploadBusy(true)
    setUploadNote(null)
    setError(null)
    try {
      const res = await uploadOrganiserFile(
        file,
        target ? { upload_id: target } : { submission_id: submissionId },
      )
      setUploadNote(`Uploaded ${file.name}${res.version > 1 ? ` (v${res.version})` : ''}.`)
      setOpen(null)
      setChain(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploadBusy(false)
    }
  }

  return (
    <>
      <h2 style={{ fontSize: 14, marginTop: 16 }}>
        Files{rows && rows.length > 0 ? ` (${rows.length})` : ''}
        <button
          type="button"
          style={{ marginLeft: 8 }}
          disabled={uploadBusy}
          onClick={() => pickFile(null)}
          title="Upload a file to this submission on the speaker's behalf"
        >
          {uploadBusy ? 'Uploading…' : 'Upload file'}
        </button>
      </h2>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        aria-label="Choose a file to upload"
        onChange={(e) => void onFilePicked(e.target as HTMLInputElement)}
      />
      {uploadNote && <p className="file-empty" role="status">{uploadNote}</p>}
      {error && <p className="file-error" role="alert">{error}</p>}
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
            <button
              type="button"
              disabled={uploadBusy}
              onClick={() => pickFile(r.upload_id)}
              title="Upload a replacement as the next version of this file"
            >
              New version
            </button>
            <span className="file-vmeta">
              {formatBytes(r.size_bytes)} · {uploadedByLabel(r) ?? 'Unknown'} ·{' '}
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

  // The library row can be stale (fetched before the latest upload), so once
  // the chain arrives the summary derives from it — the same data the version
  // list below renders. This is what fixed "Versions 1" sitting above a
  // "2 versions" list on the same page (eval defect).
  const current = chain
    ? chain.versions.find((v) => v.is_current === 1) ?? chain.versions[chain.versions.length - 1]
    : null
  const versionCount = chain ? chain.versions.length : item.version_count
  const latestAt = current?.uploaded_at ?? item.uploaded_at
  const uploadedBy = (current ? uploadedByLabel(current) : null) ?? uploadedByLabel(item) ?? 'Unknown'

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
          <dd>{uploadedBy}</dd>
        </div>
        {(item.uploader_name ?? item.uploader_email) &&
          uploadedBy !== (item.uploader_name ?? item.uploader_email) && (
            <div style={{ display: 'contents' }}>
              <dt>For</dt>
              <dd>{item.uploader_name ?? item.uploader_email}</dd>
            </div>
          )}
        <div style={{ display: 'contents' }}>
          <dt>Size</dt>
          <dd>{formatBytes(current?.size_bytes ?? item.size_bytes)}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Type</dt>
          <dd>{current?.content_type ?? item.content_type ?? '—'}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Latest upload</dt>
          <dd>{fmtDateTime(latestAt)}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Versions</dt>
          <dd>{versionCount}</dd>
        </div>
      </dl>
      {error && <p className="file-error">{error}</p>}
      {!chain && !error && <p className="file-empty">Loading…</p>}
      {chain && <FileChainPanel chain={chain} heading={item.filename} />}
    </div>
  )
}

import { useRef, useState } from 'react'
import { ApiError, uploadContactHeadshot, type ContactRow } from '../api'

/**
 * CNT-10: the organiser speaker edit form (App.tsx's `speakerSchema`, a
 * generic RecordForm schema) has no room for a file control — RecordForm is
 * a from-scratch stand-in that doesn't support uploads at all (see its doc
 * comment). Rather than teaching RecordForm a new field type for one field,
 * this is a small standalone control wired into the speakers
 * `detailComponent` next to the existing read-only `ContactHeadshot`
 * display, right where `PortalInviteButton` already lives outside the
 * generic form for the same reason (SPK-06).
 *
 * Uploads immediately on file selection (no separate "save" step — matches
 * the portal profile page's own headshot control) through
 * `POST /app/api/contacts/:id/headshot`, which shares filestore.ts's
 * `saveFile` seam (same 5 MB / image-type limits) with the speaker-facing
 * portal upload. `onUpdated` lets the caller refresh its cached row so the
 * new photo shows immediately without a full re-query.
 */
export function HeadshotUploadControl({
  item,
  onUpdated,
}: {
  item: ContactRow
  onUpdated: (headshotAssetId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const pick = () => inputRef.current?.click()

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file after an error
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const r = await uploadContactHeadshot(item.id, file)
      onUpdated(r.headshot_asset_id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The headshot could not be uploaded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="headshot-upload">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => void onChange(e)}
        aria-label={`Upload a headshot for ${item.email}`}
      />
      <button type="button" className="headshot-upload-button" disabled={busy} onClick={pick}>
        {busy ? 'Uploading…' : item.headshot_asset_id ? 'Replace headshot' : 'Upload headshot'}
      </button>
      {error && (
        <span role="status" className="compose-note-error">
          {error}
        </span>
      )}
    </div>
  )
}

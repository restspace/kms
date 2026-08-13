import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createFormat,
  createRoom,
  createTrack,
  deleteFormat,
  deleteRoom,
  deleteTrack,
  getRoomUsage,
  listFormats,
  listRooms,
  listTracks,
  restoreRoom,
  updateFormat,
  updateRoom,
  updateTrack,
  type FormatRow,
  type RoomRow,
  type TrackRow,
} from '../api'
import { appConfirm } from '../components/dialogs'
import {
  FormatRowEditor,
  RoomRowEditor,
  TrackRowEditor,
  type FormatDraftRow,
  type RoomDraftRow,
  type TrackDraftRow,
} from '../components/RoomsTracksFields'
import '../components/RoomsTracksFields.css'

/**
 * Rooms & Tracks (deferred-gap item): the agenda builder's Add Session dialog
 * only ever offered "No room" / "No track" because rooms/tracks were
 * select-only — nothing created them outside the seed SQL. This card is the
 * settings-side editor for an *existing* event, reusing the same row editors
 * as CreateEventDialog's repeatable fields but persisting each change
 * immediately (add/rename/delete are all live API calls, not a draft that
 * needs a Save button) — a freshly added room must be selectable in the
 * agenda builder the moment the operator switches tabs there.
 */

const asDraftRoom = (r: RoomRow): RoomDraftRow => ({
  key: r.id,
  name: r.name,
  capacity: r.capacity === null ? '' : String(r.capacity),
})
const asDraftTrack = (t: TrackRow): TrackDraftRow => ({ key: t.id, name: t.name, color: t.color ?? '' })
const asDraftFormat = (f: FormatRow): FormatDraftRow => ({ key: f.id, name: f.name })

export function RoomsTracksCard() {
  const [rooms, setRooms] = useState<RoomDraftRow[] | null>(null)
  const [tracks, setTracks] = useState<TrackDraftRow[] | null>(null)
  const [formats, setFormats] = useState<FormatDraftRow[] | null>(null)
  // Item 3 fix: previously a single shared `error` string with no matching
  // "did this list ever resolve?" state — a rejected `listRooms()`/`listTracks()`
  // left `rooms`/`tracks` at their initial `null` forever, and the `=== null`
  // checks below render "Loading…" unconditionally on that, so the column
  // spun forever even once `error` was populated and displayed above it.
  // Split per-column so one endpoint failing doesn't also block the other's
  // successful load, and each gets an explicit Retry.
  const [roomsError, setRoomsError] = useState<string | null>(null)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [formatsError, setFormatsError] = useState<string | null>(null)
  const [savingRoom, setSavingRoom] = useState<string | null>(null)
  const [savingTrack, setSavingTrack] = useState<string | null>(null)
  const [savingFormat, setSavingFormat] = useState<string | null>(null)
  // Eval #21: "+ Add room" used to call createRoom() on click, so a stray
  // click left a live, schedulable "New room N" in the agenda's room list
  // that had to be deleted through the confirm dialog. Name-first instead:
  // the click only opens an inline input; nothing is created (no API call)
  // until Enter commits a non-empty name. Escape/blur-empty cancels with no
  // room ever having existed.
  const [newRoomName, setNewRoomName] = useState<string | null>(null)
  const [addingRoom, setAddingRoom] = useState(false)
  // Room-delete undo (eval defect: deletion was destructive with no way back).
  // The DELETE response carries the doomed row and the ids of every session
  // that lost its room, so Undo is one restore call — same toast-with-Undo
  // affordance the agenda board uses for schedule changes.
  const [roomUndo, setRoomUndo] = useState<{ room: RoomRow; sessionIds: string[]; note: string } | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const undoTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    },
    [],
  )

  const loadRooms = useCallback(() => {
    setRoomsError(null)
    listRooms()
      .then((r) => setRooms(r.items.map(asDraftRoom)))
      .catch((e: unknown) => setRoomsError(e instanceof Error ? e.message : 'Failed to load rooms'))
  }, [])

  const loadTracks = useCallback(() => {
    setTracksError(null)
    listTracks()
      .then((r) => setTracks(r.items.map(asDraftTrack)))
      .catch((e: unknown) => setTracksError(e instanceof Error ? e.message : 'Failed to load tracks'))
  }, [])

  const loadFormats = useCallback(() => {
    setFormatsError(null)
    listFormats()
      .then((r) => setFormats(r.items.map(asDraftFormat)))
      .catch((e: unknown) => setFormatsError(e instanceof Error ? e.message : 'Failed to load formats'))
  }, [])

  useEffect(() => {
    loadRooms()
    loadTracks()
    loadFormats()
  }, [loadRooms, loadTracks, loadFormats])

  const handleCommitNewRoom = async () => {
    if (addingRoom) return // disabling the input while in flight can itself trigger a blur; ignore the re-entrant call
    const name = (newRoomName ?? '').trim()
    if (!name) {
      // Nothing was ever created — just close the input.
      setNewRoomName(null)
      return
    }
    setAddingRoom(true)
    try {
      const created = await createRoom({ name })
      setRooms((cur) => [...(cur ?? []), asDraftRoom(created)])
      setNewRoomName(null)
    } catch (e) {
      setRoomsError(e instanceof Error ? e.message : 'Failed to add the room.')
    } finally {
      setAddingRoom(false)
    }
  }

  const handleRoomNameBlur = async (row: RoomDraftRow) => {
    const name = row.name.trim()
    if (!name) {
      // An empty name is rejected server-side; reload to discard the edit
      // rather than leaving the row in a state the server never accepted.
      const fresh = await listRooms()
      setRooms(fresh.items.map(asDraftRoom))
      return
    }
    setSavingRoom(row.key)
    try {
      await updateRoom(row.key, { name })
    } catch (e) {
      setRoomsError(e instanceof Error ? e.message : 'Failed to rename the room.')
    } finally {
      setSavingRoom(null)
    }
  }

  const handleRoomCapacityBlur = async (row: RoomDraftRow) => {
    setSavingRoom(row.key)
    try {
      await updateRoom(row.key, { capacity: row.capacity.trim() === '' ? null : Number(row.capacity) })
    } catch (e) {
      setRoomsError(e instanceof Error ? e.message : 'Failed to update the room capacity.')
    } finally {
      setSavingRoom(null)
    }
  }

  const handleRemoveRoom = async (row: RoomDraftRow) => {
    // Name the blast radius before asking (eval defect: the old confirm said
    // "any scheduled sessions" without knowing whether that meant 0 or 40).
    let scheduled: number | null = null
    try {
      scheduled = (await getRoomUsage(row.key)).scheduled_count
    } catch {
      // The count is advisory; an unreachable usage endpoint must not make
      // the room undeletable. The confirm falls back to the generic wording.
    }
    const impact =
      scheduled === null
        ? 'Any scheduled sessions in this room keep their slot but lose the room.'
        : scheduled > 0
          ? `${scheduled} scheduled session${scheduled === 1 ? ' is' : 's are'} in this room — ${scheduled === 1 ? 'it keeps' : 'they keep'} their slot but lose the room.`
          : 'No scheduled sessions are in this room.'
    const confirmed = await appConfirm(`Delete "${row.name || 'this room'}"? ${impact}`, {
      title: 'Delete room',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    try {
      const res = await deleteRoom(row.key)
      setRooms((cur) => (cur ?? []).filter((r) => r.key !== row.key))
      setRoomUndo({
        room: res.room,
        sessionIds: res.detached_session_ids,
        note:
          res.detached_session_ids.length > 0
            ? `Room "${res.room.name}" deleted — ${res.detached_session_ids.length} session${res.detached_session_ids.length === 1 ? '' : 's'} kept their slot without a room.`
            : `Room "${res.room.name}" deleted.`,
      })
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      // Longer than the agenda's 6s toast on purpose: this one is the only
      // way back from a destructive delete, not a courtesy confirmation.
      undoTimer.current = window.setTimeout(() => setRoomUndo(null), 15000)
    } catch (e) {
      setRoomsError(e instanceof Error ? e.message : 'Failed to delete the room.')
    }
  }

  const handleUndoRoomDelete = async () => {
    if (!roomUndo || undoBusy) return
    setUndoBusy(true)
    try {
      await restoreRoom(roomUndo.room, roomUndo.sessionIds)
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      setRoomUndo(null)
      loadRooms()
    } catch (e) {
      setRoomsError(e instanceof Error ? e.message : 'Failed to restore the room.')
    } finally {
      setUndoBusy(false)
    }
  }

  const handleAddTrack = async () => {
    try {
      const n = (tracks?.length ?? 0) + 1
      const created = await createTrack({ name: `New track ${n}` })
      setTracks((cur) => [...(cur ?? []), asDraftTrack(created)])
    } catch (e) {
      setTracksError(e instanceof Error ? e.message : 'Failed to add the track.')
    }
  }

  const handleTrackNameBlur = async (row: TrackDraftRow) => {
    const name = row.name.trim()
    if (!name) {
      const fresh = await listTracks()
      setTracks(fresh.items.map(asDraftTrack))
      return
    }
    setSavingTrack(row.key)
    try {
      await updateTrack(row.key, { name })
    } catch (e) {
      setTracksError(e instanceof Error ? e.message : 'Failed to rename the track.')
    } finally {
      setSavingTrack(null)
    }
  }

  const handleTrackColorBlur = async (row: TrackDraftRow) => {
    setSavingTrack(row.key)
    try {
      await updateTrack(row.key, { color: row.color || null })
    } catch (e) {
      setTracksError(e instanceof Error ? e.message : 'Failed to update the track color.')
    } finally {
      setSavingTrack(null)
    }
  }

  const handleRemoveTrack = async (row: TrackDraftRow) => {
    const confirmed = await appConfirm(
      `Delete "${row.name || 'this track'}"? Any sessions on it keep their slot but lose the track.`,
      { title: 'Delete track', confirmLabel: 'Delete', danger: true },
    )
    if (!confirmed) return
    try {
      await deleteTrack(row.key)
      setTracks((cur) => (cur ?? []).filter((t) => t.key !== row.key))
    } catch (e) {
      setTracksError(e instanceof Error ? e.message : 'Failed to delete the track.')
    }
  }

  const handleAddFormat = async () => {
    try {
      const n = (formats?.length ?? 0) + 1
      const created = await createFormat({ name: `New format ${n}` })
      setFormats((cur) => [...(cur ?? []), asDraftFormat(created)])
    } catch (e) {
      setFormatsError(e instanceof Error ? e.message : 'Failed to add the format.')
    }
  }

  const handleFormatNameBlur = async (row: FormatDraftRow) => {
    const name = row.name.trim()
    if (!name) {
      const fresh = await listFormats()
      setFormats(fresh.items.map(asDraftFormat))
      return
    }
    setSavingFormat(row.key)
    try {
      await updateFormat(row.key, { name })
    } catch (e) {
      setFormatsError(e instanceof Error ? e.message : 'Failed to rename the format.')
    } finally {
      setSavingFormat(null)
    }
  }

  const handleRemoveFormat = async (row: FormatDraftRow) => {
    const confirmed = await appConfirm(
      `Delete "${row.name || 'this format'}"? Existing submissions and sessions keep the format name; it just stops being offered.`,
      { title: 'Delete format', confirmLabel: 'Delete', danger: true },
    )
    if (!confirmed) return
    try {
      await deleteFormat(row.key)
      setFormats((cur) => (cur ?? []).filter((f) => f.key !== row.key))
    } catch (e) {
      setFormatsError(e instanceof Error ? e.message : 'Failed to delete the format.')
    }
  }

  return (
    <section className="settings-card">
      <h2>Rooms, tracks & formats</h2>
      <p className="settings-hint">
        Changes here appear in the agenda builder&rsquo;s Add Session dialog immediately. Formats also
        drive the submission form&rsquo;s Format dropdown; put the default length in the name (e.g.
        &ldquo;Talk (30 min)&rdquo;) and new sessions pick it up.
      </p>

      {roomUndo && (
        <div className="settings-undo-toast" role="status">
          <span>{roomUndo.note}</span>
          <button type="button" disabled={undoBusy} onClick={() => void handleUndoRoomDelete()}>
            {undoBusy ? 'Restoring…' : 'Undo'}
          </button>
          <button type="button" className="settings-ghost" onClick={() => setRoomUndo(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="settings-rt-columns">
        <div>
          <h3>Rooms</h3>
          {roomsError && rooms === null ? (
            <div className="settings-error">
              {roomsError}{' '}
              <button type="button" className="settings-ghost" onClick={() => loadRooms()}>
                Retry
              </button>
            </div>
          ) : rooms === null ? (
            <div className="settings-hint">Loading…</div>
          ) : (
            <>
              {roomsError && <div className="settings-error">{roomsError}</div>}
            <div className="rt-field">
              {rooms.map((row) => (
                <div key={row.key} className={savingRoom === row.key ? 'rt-row-saving' : undefined}>
                  <RoomRowEditor
                    row={row}
                    onNameChange={(name) => setRooms((cur) => (cur ?? []).map((r) => (r.key === row.key ? { ...r, name } : r)))}
                    onCapacityChange={(capacity) =>
                      setRooms((cur) => (cur ?? []).map((r) => (r.key === row.key ? { ...r, capacity } : r)))
                    }
                    onNameBlur={() => void handleRoomNameBlur(row)}
                    onCapacityBlur={() => void handleRoomCapacityBlur(row)}
                    onRemove={() => void handleRemoveRoom(row)}
                  />
                </div>
              ))}
              {newRoomName !== null ? (
                <input
                  type="text"
                  className="rt-row-name rt-new-row"
                  placeholder="Room name"
                  aria-label="New room name"
                  autoFocus
                  value={newRoomName}
                  disabled={addingRoom}
                  onChange={(e) => setNewRoomName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleCommitNewRoom()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setNewRoomName(null)
                    }
                  }}
                  onBlur={() => {
                    // An empty name on blur just closes the input — no room
                    // is created either way, so there is nothing to confirm.
                    if (newRoomName.trim() === '') setNewRoomName(null)
                    else void handleCommitNewRoom()
                  }}
                />
              ) : (
                <button type="button" className="rt-add" onClick={() => setNewRoomName('')}>
                  + Add room
                </button>
              )}
            </div>
            </>
          )}
        </div>

        <div>
          <h3>Tracks</h3>
          {tracksError && tracks === null ? (
            <div className="settings-error">
              {tracksError}{' '}
              <button type="button" className="settings-ghost" onClick={() => loadTracks()}>
                Retry
              </button>
            </div>
          ) : tracks === null ? (
            <div className="settings-hint">Loading…</div>
          ) : (
            <>
              {tracksError && <div className="settings-error">{tracksError}</div>}
            <div className="rt-field">
              {tracks.map((row) => (
                <div key={row.key} className={savingTrack === row.key ? 'rt-row-saving' : undefined}>
                  <TrackRowEditor
                    row={row}
                    onNameChange={(name) => setTracks((cur) => (cur ?? []).map((t) => (t.key === row.key ? { ...t, name } : t)))}
                    onColorChange={(color) => setTracks((cur) => (cur ?? []).map((t) => (t.key === row.key ? { ...t, color } : t)))}
                    onNameBlur={() => void handleTrackNameBlur(row)}
                    onColorBlur={() => void handleTrackColorBlur(row)}
                    onRemove={() => void handleRemoveTrack(row)}
                  />
                </div>
              ))}
              <button type="button" className="rt-add" onClick={() => void handleAddTrack()}>
                + Add track
              </button>
            </div>
            </>
          )}
        </div>

        <div>
          <h3>Formats</h3>
          {formatsError && formats === null ? (
            <div className="settings-error">
              {formatsError}{' '}
              <button type="button" className="settings-ghost" onClick={() => loadFormats()}>
                Retry
              </button>
            </div>
          ) : formats === null ? (
            <div className="settings-hint">Loading…</div>
          ) : (
            <>
              {formatsError && <div className="settings-error">{formatsError}</div>}
            <div className="rt-field">
              {formats.map((row) => (
                <div key={row.key} className={savingFormat === row.key ? 'rt-row-saving' : undefined}>
                  <FormatRowEditor
                    row={row}
                    onNameChange={(name) => setFormats((cur) => (cur ?? []).map((f) => (f.key === row.key ? { ...f, name } : f)))}
                    onNameBlur={() => void handleFormatNameBlur(row)}
                    onRemove={() => void handleRemoveFormat(row)}
                  />
                </div>
              ))}
              <button type="button" className="rt-add" onClick={() => void handleAddFormat()}>
                + Add format
              </button>
            </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

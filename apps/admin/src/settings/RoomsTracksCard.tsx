import { useEffect, useState } from 'react'
import {
  createRoom,
  createTrack,
  deleteRoom,
  deleteTrack,
  listRooms,
  listTracks,
  updateRoom,
  updateTrack,
  type RoomRow,
  type TrackRow,
} from '../api'
import { appConfirm } from '../components/dialogs'
import { RoomRowEditor, TrackRowEditor, type RoomDraftRow, type TrackDraftRow } from '../components/RoomsTracksFields'
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

export function RoomsTracksCard() {
  const [rooms, setRooms] = useState<RoomDraftRow[] | null>(null)
  const [tracks, setTracks] = useState<TrackDraftRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savingRoom, setSavingRoom] = useState<string | null>(null)
  const [savingTrack, setSavingTrack] = useState<string | null>(null)

  useEffect(() => {
    listRooms().then((r) => setRooms(r.items.map(asDraftRoom))).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load rooms'))
    listTracks().then((r) => setTracks(r.items.map(asDraftTrack))).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load tracks'))
  }, [])

  const handleAddRoom = async () => {
    try {
      const n = (rooms?.length ?? 0) + 1
      const created = await createRoom({ name: `New room ${n}` })
      setRooms((cur) => [...(cur ?? []), asDraftRoom(created)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the room.')
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
      setError(e instanceof Error ? e.message : 'Failed to rename the room.')
    } finally {
      setSavingRoom(null)
    }
  }

  const handleRoomCapacityBlur = async (row: RoomDraftRow) => {
    setSavingRoom(row.key)
    try {
      await updateRoom(row.key, { capacity: row.capacity.trim() === '' ? null : Number(row.capacity) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the room capacity.')
    } finally {
      setSavingRoom(null)
    }
  }

  const handleRemoveRoom = async (row: RoomDraftRow) => {
    const confirmed = await appConfirm(
      `Delete "${row.name || 'this room'}"? Any scheduled sessions keep their slot but lose the room.`,
      { title: 'Delete room', confirmLabel: 'Delete', danger: true },
    )
    if (!confirmed) return
    try {
      await deleteRoom(row.key)
      setRooms((cur) => (cur ?? []).filter((r) => r.key !== row.key))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the room.')
    }
  }

  const handleAddTrack = async () => {
    try {
      const n = (tracks?.length ?? 0) + 1
      const created = await createTrack({ name: `New track ${n}` })
      setTracks((cur) => [...(cur ?? []), asDraftTrack(created)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the track.')
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
      setError(e instanceof Error ? e.message : 'Failed to rename the track.')
    } finally {
      setSavingTrack(null)
    }
  }

  const handleTrackColorBlur = async (row: TrackDraftRow) => {
    setSavingTrack(row.key)
    try {
      await updateTrack(row.key, { color: row.color || null })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the track color.')
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
      setError(e instanceof Error ? e.message : 'Failed to delete the track.')
    }
  }

  return (
    <section className="settings-card">
      <h2>Rooms & tracks</h2>
      <p className="settings-hint">
        Changes here appear in the agenda builder&rsquo;s Add Session dialog immediately.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-rt-columns">
        <div>
          <h3>Rooms</h3>
          {rooms === null ? (
            <div className="settings-hint">Loading…</div>
          ) : (
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
              <button type="button" className="rt-add" onClick={() => void handleAddRoom()}>
                + Add room
              </button>
            </div>
          )}
        </div>

        <div>
          <h3>Tracks</h3>
          {tracks === null ? (
            <div className="settings-hint">Loading…</div>
          ) : (
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
          )}
        </div>
      </div>
    </section>
  )
}

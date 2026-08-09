import './RecordForm.css'
import './RoomsTracksFields.css'

/**
 * Shared "repeatable row" building blocks for a room/track editor. Two
 * consumers: CreateEventDialog (rows are pure local draft state, submitted
 * once with the rest of the create-event form) and the settings Rooms &
 * Tracks card (each row edit is an immediate API call against an existing
 * event). Both render the same row shape so the two surfaces read as one
 * feature rather than two independently-invented forms.
 */

export interface RoomDraftRow {
  /** Client-side key for React lists / diffing — not necessarily a server id. */
  key: string
  name: string
  /** Held as text so a half-typed number stays visible; parsed on submit/blur. */
  capacity: string
}

export interface TrackDraftRow {
  key: string
  name: string
  color: string
}

export const emptyRoomRow = (): RoomDraftRow => ({ key: crypto.randomUUID(), name: '', capacity: '' })
export const emptyTrackRow = (): TrackDraftRow => ({ key: crypto.randomUUID(), name: '', color: '' })

interface RoomRowEditorProps {
  row: RoomDraftRow
  onNameChange: (name: string) => void
  onCapacityChange: (capacity: string) => void
  onRemove: () => void
  onNameBlur?: () => void
  onCapacityBlur?: () => void
  disabled?: boolean
  nameLabel?: string
  removeLabel?: string
}

export function RoomRowEditor({
  row,
  onNameChange,
  onCapacityChange,
  onRemove,
  onNameBlur,
  onCapacityBlur,
  disabled,
  nameLabel = 'Room name',
  removeLabel = 'Remove room',
}: RoomRowEditorProps) {
  return (
    <div className="rt-row">
      <input
        type="text"
        className="rt-row-name"
        placeholder="Room name"
        aria-label={nameLabel}
        value={row.name}
        onChange={(e) => onNameChange((e.target as HTMLInputElement).value)}
        onBlur={onNameBlur}
        disabled={disabled}
      />
      <input
        type="number"
        min={0}
        step={1}
        className="rt-row-extra"
        placeholder="Capacity"
        aria-label="Room capacity"
        value={row.capacity}
        onChange={(e) => onCapacityChange((e.target as HTMLInputElement).value)}
        onBlur={onCapacityBlur}
        disabled={disabled}
      />
      <button
        type="button"
        className="rt-row-remove"
        aria-label={removeLabel}
        onClick={onRemove}
        disabled={disabled}
      >
        ×
      </button>
    </div>
  )
}

interface TrackRowEditorProps {
  row: TrackDraftRow
  onNameChange: (name: string) => void
  onColorChange: (color: string) => void
  onRemove: () => void
  onNameBlur?: () => void
  onColorBlur?: () => void
  disabled?: boolean
  nameLabel?: string
  removeLabel?: string
}

export function TrackRowEditor({
  row,
  onNameChange,
  onColorChange,
  onRemove,
  onNameBlur,
  onColorBlur,
  disabled,
  nameLabel = 'Track name',
  removeLabel = 'Remove track',
}: TrackRowEditorProps) {
  return (
    <div className="rt-row">
      <input
        type="text"
        className="rt-row-name"
        placeholder="Track name"
        aria-label={nameLabel}
        value={row.name}
        onChange={(e) => onNameChange((e.target as HTMLInputElement).value)}
        onBlur={onNameBlur}
        disabled={disabled}
      />
      <input
        type="color"
        className="rt-row-color"
        aria-label="Track color"
        value={row.color || '#94a3b8'}
        onChange={(e) => onColorChange((e.target as HTMLInputElement).value)}
        onBlur={onColorBlur}
        disabled={disabled}
      />
      <button
        type="button"
        className="rt-row-remove"
        aria-label={removeLabel}
        onClick={onRemove}
        disabled={disabled}
      >
        ×
      </button>
    </div>
  )
}

interface RoomsRepeatableFieldProps {
  rows: RoomDraftRow[]
  onChange: (rows: RoomDraftRow[]) => void
  disabled?: boolean
}

/** Local-only add/edit/remove — the caller owns when the rows are persisted. */
export function RoomsRepeatableField({ rows, onChange, disabled }: RoomsRepeatableFieldProps) {
  return (
    <div className="rt-field">
      {rows.map((row) => (
        <RoomRowEditor
          key={row.key}
          row={row}
          disabled={disabled}
          onNameChange={(name) => onChange(rows.map((r) => (r.key === row.key ? { ...r, name } : r)))}
          onCapacityChange={(capacity) => onChange(rows.map((r) => (r.key === row.key ? { ...r, capacity } : r)))}
          onRemove={() => onChange(rows.filter((r) => r.key !== row.key))}
        />
      ))}
      <button type="button" className="rt-add" onClick={() => onChange([...rows, emptyRoomRow()])} disabled={disabled}>
        + Add room
      </button>
    </div>
  )
}

interface TracksRepeatableFieldProps {
  rows: TrackDraftRow[]
  onChange: (rows: TrackDraftRow[]) => void
  disabled?: boolean
}

export function TracksRepeatableField({ rows, onChange, disabled }: TracksRepeatableFieldProps) {
  return (
    <div className="rt-field">
      {rows.map((row) => (
        <TrackRowEditor
          key={row.key}
          row={row}
          disabled={disabled}
          onNameChange={(name) => onChange(rows.map((r) => (r.key === row.key ? { ...r, name } : r)))}
          onColorChange={(color) => onChange(rows.map((r) => (r.key === row.key ? { ...r, color } : r)))}
          onRemove={() => onChange(rows.filter((r) => r.key !== row.key))}
        />
      ))}
      <button type="button" className="rt-add" onClick={() => onChange([...rows, emptyTrackRow()])} disabled={disabled}>
        + Add track
      </button>
    </div>
  )
}

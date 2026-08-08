// The session being dragged. dataTransfer payloads are unreadable during
// dragover in Chromium, so ghost previews read this module-level record
// instead; it lives only for the duration of one drag gesture.

export interface DragInfo {
  id: string
  durationMin: number
  fromTray: boolean
}

let current: DragInfo | null = null

export const setDrag = (info: DragInfo | null): void => {
  current = info
}

export const getDrag = (): DragInfo | null => current

import { useCallback, useEffect, useRef, useState } from 'react'
import './dialogs.css'

/**
 * Promise-based replacements for window.alert / window.confirm (docs/12 M6
 * workspace polish). Call sites `await appConfirm(...)` exactly where they
 * used to branch on window.confirm; <DialogHost /> renders once at the app
 * root and services the queue. Focus lands on the primary button; Escape
 * cancels, Enter confirms.
 */

interface DialogRequest {
  kind: 'alert' | 'confirm'
  message: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (confirmed: boolean) => void
}

let enqueue: ((request: DialogRequest) => void) | null = null
const pending: DialogRequest[] = []

function submit(request: DialogRequest): void {
  if (enqueue) enqueue(request)
  else pending.push(request)
}

export function appAlert(message: string, title?: string): Promise<void> {
  return new Promise((resolve) => {
    submit({ kind: 'alert', message, title, resolve: () => resolve() })
  })
}

export function appConfirm(
  message: string,
  options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    submit({ kind: 'confirm', message, ...options, resolve })
  })
}

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([])
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const current = queue[0] ?? null

  useEffect(() => {
    enqueue = (request) => setQueue((q) => [...q, request])
    if (pending.length > 0) {
      const drained = pending.splice(0, pending.length)
      setQueue((q) => [...q, ...drained])
    }
    return () => {
      enqueue = null
    }
  }, [])

  useEffect(() => {
    if (current) primaryRef.current?.focus()
  }, [current])

  const close = useCallback((confirmed: boolean) => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.resolve(confirmed)
      return rest
    })
  }, [])

  if (!current) return null

  return (
    <div
      className="app-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close(false)
        }
      }}
    >
      <div
        className="app-dialog"
        role={current.kind === 'confirm' ? 'alertdialog' : 'alertdialog'}
        aria-modal="true"
        aria-label={current.title ?? (current.kind === 'confirm' ? 'Confirm' : 'Notice')}
      >
        {current.title && <h3 className="app-dialog-title">{current.title}</h3>}
        <p className="app-dialog-message">{current.message}</p>
        <div className="app-dialog-actions">
          {current.kind === 'confirm' && (
            <button type="button" className="app-dialog-cancel" onClick={() => close(false)}>
              {current.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className={`app-dialog-primary ${current.danger ? 'danger' : ''}`}
            onClick={() => close(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                close(true)
              }
            }}
          >
            {current.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import './dialogs.css'

/**
 * Promise-based replacements for window.alert / window.confirm (docs/12 M6
 * workspace polish). Call sites `await appConfirm(...)` exactly where they
 * used to branch on window.confirm; <DialogHost /> renders once at the app
 * root and services the queue. Focus lands on the primary button; Escape
 * cancels, Enter confirms.
 *
 * Also exports the shared modal primitives (`useFocusTrap`, `ModalDialog`)
 * used by DialogHost itself and adopted by agenda/dialogs.tsx, FormBuilder,
 * and DataTabManager's unsaved-changes prompt.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Traps Tab/Shift+Tab focus cycling within `containerRef` while `active`.
 * Queries focusable descendants fresh on every keydown so dynamically
 * added/removed controls (e.g. conditional fields) stay correct.
 */
export function useFocusTrap(active: boolean, containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeEl = document.activeElement as HTMLElement | null

      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (activeEl === last || !container.contains(activeEl)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, containerRef])
}

export interface ModalDialogProps {
  open: boolean
  title: string
  onClose: () => void
  /** Backdrop click + Escape close the dialog. Defaults to true. */
  dismissable?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  danger?: boolean
  width?: 'sm' | 'md' | 'lg'
  children: React.ReactNode
  footer?: React.ReactNode
  /** Header "✕" close button. Defaults to `dismissable`. Pass false to opt out. */
  closeButton?: boolean
}

/**
 * Shared modal shell: portals to document.body, focus-traps while open,
 * saves/restores the opener's focus, and closes on Escape (backdrop click
 * too, unless dismissable=false).
 */
export function ModalDialog({
  open,
  title,
  onClose,
  dismissable = true,
  initialFocusRef,
  danger = false,
  width = 'md',
  children,
  footer,
  closeButton,
}: ModalDialogProps) {
  const showCloseButton = closeButton ?? dismissable
  const containerRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  const titleId = useId()

  useFocusTrap(open, containerRef)

  useEffect(() => {
    if (!open) return

    openerRef.current = document.activeElement

    const focusTarget = initialFocusRef?.current ?? containerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    focusTarget?.focus()

    return () => {
      const opener = openerRef.current as HTMLElement | null
      opener?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation()
        onClose()
      }
    },
    [dismissable, onClose],
  )

  if (!open) return null

  const dialog = (
    <div
      className="app-dialog-backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={containerRef}
        className={`app-dialog app-dialog-${width}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <div className="app-dialog-header">
          <h3 id={titleId} className="app-dialog-title">{title}</h3>
          {showCloseButton && (
            <button
              type="button"
              className="app-dialog-close"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          )}
        </div>
        <div className="app-dialog-body">{children}</div>
        {footer && <div className={`app-dialog-actions ${danger ? 'danger' : ''}`}>{footer}</div>}
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : null
}

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

  const close = useCallback((confirmed: boolean) => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.resolve(confirmed)
      return rest
    })
  }, [])

  return (
    <ModalDialog
      open={current !== null}
      title={current?.title ?? (current?.kind === 'confirm' ? 'Confirm' : 'Notice')}
      onClose={() => close(false)}
      initialFocusRef={primaryRef}
      danger={current?.danger}
      closeButton={false}
      footer={
        current && (
          <>
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
          </>
        )
      }
    >
      {current && <p className="app-dialog-message">{current.message}</p>}
    </ModalDialog>
  )
}

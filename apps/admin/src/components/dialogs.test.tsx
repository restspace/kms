import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { axe } from 'vitest-axe'
import { useRef } from 'react'
import { ModalDialog } from './dialogs'

const AXE_OPTIONS = { rules: { region: { enabled: false } } }

function Harness({
  open,
  onClose,
  dismissable,
}: {
  open: boolean
  onClose: () => void
  dismissable?: boolean
}) {
  const firstRef = useRef<HTMLInputElement | null>(null)
  return (
    <div>
      <button type="button">Opener</button>
      <ModalDialog
        open={open}
        title="Test dialog"
        onClose={onClose}
        dismissable={dismissable}
        initialFocusRef={firstRef}
        footer={
          <>
            <button type="button">Last</button>
          </>
        }
      >
        <input ref={firstRef} placeholder="first field" />
        <input placeholder="second field" />
      </ModalDialog>
    </div>
  )
}

describe('ModalDialog', () => {
  it('renders nothing when closed', () => {
    render(<Harness open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders open with role=dialog, aria-modal, and focus inside on open', async () => {
    render(<Harness open={true} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByPlaceholderText('first field'))
    })
  })

  it('wraps Tab from the last focusable back to the first (the header close button)', async () => {
    render(<Harness open={true} onClose={() => {}} />)
    const last = screen.getByText('Last')
    last.focus()
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('wraps Shift+Tab from the first focusable (close button) back to the last', async () => {
    render(<Harness open={true} onClose={() => {}} />)
    const closeButton = screen.getByRole('button', { name: 'Close' })
    closeButton.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('Last'))
  })

  it('renders a header close button that is reachable via Tab and calls onClose', async () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} />)
    const closeButton = screen.getByRole('button', { name: 'Close' })
    // reachable: it's part of the trapped focusable set (proven by the wrap tests above)
    closeButton.focus()
    expect(document.activeElement).toBe(closeButton)
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('omits the close button when closeButton=false (DialogHost look)', () => {
    render(
      <ModalDialog open={true} title="No close button" onClose={() => {}} closeButton={false}>
        content
      </ModalDialog>,
    )
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on Escape when dismissable=false', () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} dismissable={false} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('restores focus to the opener after close', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'external opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { rerender } = render(
      <ModalDialog open={true} title="T" onClose={() => {}}>
        <button type="button">Inside</button>
      </ModalDialog>,
    )
    await waitFor(() => {
      expect(document.activeElement).not.toBe(opener)
    })

    rerender(
      <ModalDialog open={false} title="T" onClose={() => {}}>
        <button type="button">Inside</button>
      </ModalDialog>,
    )
    await waitFor(() => {
      expect(document.activeElement).toBe(opener)
    })
    opener.remove()
  })

  it('has no axe violations while open', async () => {
    render(<Harness open={true} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    const results = await axe(dialog, AXE_OPTIONS)
    expect(results.violations).toHaveLength(0)
  })
})

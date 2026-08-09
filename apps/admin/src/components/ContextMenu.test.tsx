import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { axe } from 'vitest-axe'
import { ContextMenu, type ContextMenuOption } from './ContextMenu'

const AXE_OPTIONS = { rules: { region: { enabled: false } } }

function baseOptions(): ContextMenuOption[] {
  return [
    { label: 'Detail', onClick: vi.fn(), hint: 'double-click' },
    { label: 'Make global filter', onClick: vi.fn(), hint: 'Shift-click' },
    { label: 'Close', onClick: vi.fn() },
  ]
}

describe('ContextMenu', () => {
  it('focuses the first item on open', async () => {
    render(<ContextMenu position={{ x: 10, y: 10 }} options={baseOptions()} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Detail/ }))
    })
  })

  it('cycles focus with ArrowDown and ArrowUp', async () => {
    render(<ContextMenu position={{ x: 10, y: 10 }} options={baseOptions()} onClose={vi.fn()} />)
    const detail = await screen.findByRole('menuitem', { name: /Detail/ })
    await waitFor(() => expect(document.activeElement).toBe(detail))

    fireEvent.keyDown(detail, { key: 'ArrowDown' })
    const makeGlobal = screen.getByRole('menuitem', { name: /Make global filter/ })
    expect(document.activeElement).toBe(makeGlobal)

    fireEvent.keyDown(makeGlobal, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Close/ }))

    // wraps past the end back to the first item
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Close/ }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Detail/ }))

    // wraps past the start back to the last item
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Detail/ }), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Close/ }))
  })

  it('Home/End jump to first/last item', async () => {
    render(<ContextMenu position={{ x: 10, y: 10 }} options={baseOptions()} onClose={vi.fn()} />)
    const detail = await screen.findByRole('menuitem', { name: /Detail/ })
    await waitFor(() => expect(document.activeElement).toBe(detail))
    fireEvent.keyDown(detail, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Close/ }))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Close/ }), { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Detail/ }))
  })

  it('Enter activates the focused item onClick', async () => {
    const options = baseOptions()
    render(<ContextMenu position={{ x: 10, y: 10 }} options={options} onClose={vi.fn()} />)
    const detail = await screen.findByRole('menuitem', { name: /Detail/ })
    await waitFor(() => expect(document.activeElement).toBe(detail))
    fireEvent.keyDown(detail, { key: 'Enter' })
    expect(options[0].onClick).toHaveBeenCalledTimes(1)
  })

  it('Escape closes and restores focus to the opener', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'row trigger'
    document.body.appendChild(opener)
    opener.focus()

    const onClose = vi.fn()
    const { unmount } = render(
      <ContextMenu position={{ x: 10, y: 10 }} options={baseOptions()} onClose={onClose} />,
    )
    const detail = await screen.findByRole('menuitem', { name: /Detail/ })
    await waitFor(() => expect(document.activeElement).toBe(detail))

    fireEvent.keyDown(detail, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // Simulate the parent honoring onClose by unmounting the menu.
    unmount()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('renders hints right-aligned/dimmed via the hint class', async () => {
    render(<ContextMenu position={{ x: 10, y: 10 }} options={baseOptions()} onClose={vi.fn()} />)
    const hint = await screen.findByText('double-click')
    expect(hint.className).toContain('context-menu-item-hint')
  })

  it('disables items marked disabled and skips them when cycling', async () => {
    const options: ContextMenuOption[] = [
      { label: 'One', onClick: vi.fn() },
      { label: 'Two', onClick: vi.fn(), disabled: true },
      { label: 'Three', onClick: vi.fn() },
    ]
    render(<ContextMenu position={{ x: 0, y: 0 }} options={options} onClose={vi.fn()} />)
    const one = await screen.findByRole('menuitem', { name: 'One' })
    await waitFor(() => expect(document.activeElement).toBe(one))
    expect((screen.getByRole('menuitem', { name: 'Two' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(one, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Three' }))
  })

  it('has no axe violations while open', async () => {
    render(<ContextMenu position={{ x: 10, y: 10 }} options={baseOptions()} onClose={vi.fn()} />)
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).toBe(menu))
    const results = await axe(menu, AXE_OPTIONS)
    expect(results.violations).toHaveLength(0)
  })
})

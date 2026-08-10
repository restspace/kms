import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/preact'
import { DesktopOnlyNotice, desktopOnlyCss } from './DesktopOnlyNotice'

describe('DesktopOnlyNotice', () => {
  it('renders the title, the message and a read-only summary slot', () => {
    render(
      <DesktopOnlyNotice
        title="The agenda builder needs a wider window."
        message="Dragging sessions between rooms needs more room than a phone has."
        summary={<p>3 sessions today</p>}
      />,
    )
    expect(screen.getByText('The agenda builder needs a wider window.')).toBeTruthy()
    expect(screen.getByText('Dragging sessions between rooms needs more room than a phone has.')).toBeTruthy()
    expect(screen.getByText('3 sessions today')).toBeTruthy()
  })

  it('offers exactly one action, as a button when it has an onClick', () => {
    const onClick = vi.fn()
    const { container } = render(
      <DesktopOnlyNotice title="Wider window needed." action={{ label: 'Cancel import', onClick }} />,
    )
    const actions = container.querySelectorAll('.kms-desktop-only-action')
    expect(actions.length).toBe(1)
    const button = screen.getByRole('button', { name: 'Cancel import' })
    button.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders an action with an href as a link', () => {
    render(
      <DesktopOnlyNotice title="Wider window needed." action={{ label: 'Preview the public form', href: '/submit/x' }} />,
    )
    expect(screen.getByRole('link', { name: 'Preview the public form' }).getAttribute('href')).toBe('/submit/x')
  })

  it('renders no action when none is given', () => {
    const { container } = render(<DesktopOnlyNotice title="Wider window needed." />)
    expect(container.querySelectorAll('.kms-desktop-only-action').length).toBe(0)
  })

  it('touches no viewport API — the gate is CSS, not JS', () => {
    const matchMedia = vi.fn()
    const original = window.matchMedia
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia
    try {
      render(<DesktopOnlyNotice title="Wider window needed." message="Because." />)
      expect(matchMedia).not.toHaveBeenCalled()
    } finally {
      window.matchMedia = original
    }
    expect(DesktopOnlyNotice.toString()).not.toContain('window')
  })

  it('exports the CSS-only composition gate at the compact breakpoint', () => {
    expect(desktopOnlyCss).toContain('.kms-compact-only { display: none; }')
    expect(desktopOnlyCss).toContain('@media (max-width: 640px)')
    expect(desktopOnlyCss).toContain('.kms-wide-only { display: none; }')
  })
})

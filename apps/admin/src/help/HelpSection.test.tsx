// The in-app manual reader. What matters here is that the build-time HTML
// actually reaches the DOM, that an unknown slug degrades to the contents page
// instead of a blank screen, and that a cross-page link inside the prose
// navigates within the SPA rather than reloading the app.

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('../router', async () => {
  const actual = await vi.importActual<typeof import('../router')>('../router')
  return { ...actual, navigate }
})

import { HelpSection } from './HelpSection'

describe('HelpSection', () => {
  it('renders the requested page, converted from its markdown', async () => {
    render(<HelpSection slug="agenda" />)
    // The body arrives with the dynamically imported chunk, not on first paint.
    expect(await screen.findByRole('heading', { level: 1, name: 'Agenda' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Views' })).toBeTruthy())
  })

  it('shows the contents page for a missing slug rather than an empty screen', async () => {
    render(<HelpSection slug="no-such-page" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'User Manual' })).toBeTruthy()
  })

  it('defaults to the contents page when no slug is in the URL', async () => {
    render(<HelpSection slug={null} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'User Manual' })).toBeTruthy()
  })

  it('lists the manual’s own sections in the contents rail', () => {
    render(<HelpSection slug="agenda" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Workflow guides' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Screen reference' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy()
  })

  it('marks the page being read as current in the rail', () => {
    render(<HelpSection slug="agenda" />)
    expect(screen.getByRole('button', { name: 'Agenda' }).getAttribute('aria-current')).toBe('page')
  })

  it('navigates in-app when a link inside the prose is clicked', async () => {
    navigate.mockClear()
    render(<HelpSection slug="agenda" />)
    await screen.findByRole('heading', { level: 1, name: 'Agenda' })

    const link = await waitFor(() => {
      const found = document.querySelector('.manual-body a[href^="?v=help"]')
      if (!found) throw new Error('no cross-page link rendered')
      return found as HTMLAnchorElement
    })
    const target = new URLSearchParams(link.getAttribute('href')!.split('#')[0]!.replace(/^\?/, '')).get('page')

    fireEvent.click(link, { button: 0 })
    expect(navigate).toHaveBeenCalledWith({ v: 'help', page: target })
  })
})

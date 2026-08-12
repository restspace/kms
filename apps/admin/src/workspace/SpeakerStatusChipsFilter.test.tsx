// SPK-04: the Speakers-tab roster filter chips — built-ins plus this event's
// custom speaker_status_options.

import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/preact'
import { useState } from 'react'
import { SpeakerStatusChipsFilter } from './extras'

function Harness({ options = [] as Array<{ key: string; label: string }>, onChange }: {
  options?: Array<{ key: string; label: string }>
  onChange?: (filters: Record<string, string>) => void
}) {
  const [filters, setFilters] = useState<Record<string, string>>({ speaker_status: '' })
  return (
    <SpeakerStatusChipsFilter
      filters={filters}
      setFilters={(next) => {
        setFilters((prev) => {
          const resolved = typeof next === 'function' ? (next as (p: Record<string, string>) => Record<string, string>)(prev) : next
          onChange?.(resolved)
          return resolved
        })
      }}
      resetFilters={() => setFilters({ speaker_status: '' })}
      options={options}
    />
  )
}

describe('SpeakerStatusChipsFilter', () => {
  it('renders the five built-in chips plus All', () => {
    render(<Harness />)
    for (const label of ['All', 'Prospect', 'Invited', 'Awaiting reply', 'Confirmed', 'Declined']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('renders custom options after the built-ins and selecting one sets speaker_status', () => {
    const onChange = vi.fn()
    render(<Harness options={[{ key: 'on_the_fence', label: 'On the fence' }]} onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'On the fence' })
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith({ speaker_status: 'on_the_fence' })
  })

  it('clicking a built-in chip sets speaker_status, and All clears it', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed' }))
    expect(onChange).toHaveBeenLastCalledWith({ speaker_status: 'confirmed' })
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onChange).toHaveBeenLastCalledWith({ speaker_status: '' })
  })
})

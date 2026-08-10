/**
 * Eval defect 2: the Speakers tab's Sessions section vanished indistinguishably
 * whether a speaker genuinely had no sessions, or the submissions fetch for
 * their `contact_id` failed. `Promise.all([...]).then(...)` had no `.catch`,
 * so a rejection just left `rows` at its initial `null` forever — identical
 * to the render for zero rows (`if (!rows || rows.length === 0) return null`).
 * That is how a real SESS-18 participant (Marcus Okafor, per the eval report)
 * could show no Sessions section while another speaker's rendered fine: not
 * because the broad `contact_id` filter fails to match participants (it does
 * — adminApi.ts's submissions resource matches submitter OR participant), but
 * because some transient failure for his fetch was silently swallowed.
 *
 * These tests exercise the fixed tri-state (loading / error / rows) directly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

const { queryResourceMock, listRoomsMock } = vi.hoisted(() => ({
  queryResourceMock: vi.fn(),
  listRoomsMock: vi.fn(),
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    queryResource: () => queryResourceMock,
    listRooms: listRoomsMock,
  };
});

import { SpeakerSessions } from './App';

beforeEach(() => {
  queryResourceMock.mockReset();
  listRoomsMock.mockReset();
  listRoomsMock.mockResolvedValue({ items: [] });
});

describe('SpeakerSessions', () => {
  it('renders the sessions list on success', async () => {
    queryResourceMock.mockResolvedValue({
      items: [{ id: 'sub-1', code: 'SESS-18', title: 'Scaling Rust services', starts_at: null, room_id: null }],
      total: 1,
    });

    render(<SpeakerSessions contactId="c-marcus" />);

    expect(await screen.findByText('Scaling Rust services')).toBeTruthy();
    expect(queryResourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { contact_id: 'c-marcus' } }),
    );
  });

  it('shows an explicit "No sessions" state rather than vanishing when there genuinely are none', async () => {
    queryResourceMock.mockResolvedValue({ items: [], total: 0 });

    const { container } = render(<SpeakerSessions contactId="c-empty" />);

    await waitFor(() => expect(screen.getByText(/No sessions/)).toBeTruthy());
    // The heading still renders — the section is present, just empty.
    expect(container.querySelector('h3')?.textContent).toBe('Sessions');
  });

  it('shows a visible error with Retry instead of silently disappearing on a fetch failure', async () => {
    queryResourceMock.mockRejectedValueOnce(new Error('network hiccup'));

    render(<SpeakerSessions contactId="c-marcus" />);

    expect(await screen.findByText(/network hiccup/)).toBeTruthy();
    const retry = screen.getByText('Retry');
    expect(retry).toBeTruthy();

    // Recovers on retry once the transient failure clears.
    queryResourceMock.mockResolvedValueOnce({
      items: [{ id: 'sub-1', code: 'SESS-18', title: 'Scaling Rust services', starts_at: null, room_id: null }],
      total: 1,
    });
    (retry as HTMLElement).click();

    expect(await screen.findByText('Scaling Rust services')).toBeTruthy();
  });
});

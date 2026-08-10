// EMB-16 (event-timezone time formatting) + EMB-02 (speaker-name search) for
// the public sessions-list widget.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { SessionsWidget } from './SessionsWidget';
import type { AgendaFeed } from '../publicData';

const feed: AgendaFeed = {
  event: { name: 'DevFlow Conf', slug: 'devflow', timezone: 'America/Los_Angeles' },
  days: ['2027-05-12'],
  rooms: [{ id: 'r1', name: 'Main Stage', capacity: 200 }],
  tracks: [{ id: 't1', name: 'Agents', color: '#5566ff' }],
  sessions: [
    {
      id: 's1',
      code: 'SESS-1',
      title: 'Building Reliable Multi-Agent Pipelines',
      description: null,
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: 't1',
      room_id: 'r1',
      starts_at: '2027-05-12T17:00:00.000Z',
      ends_at: '2027-05-12T17:30:00.000Z',
      day: '2027-05-12',
      speakers: ['Ada Lovelace'],
      speaker_details: [{ id: 'sp1', name: 'Ada Lovelace', title: 'Principal Engineer', company: 'Analytical Co' }],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => feed }) as Response),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('SessionsWidget', () => {
  it('renders the session time in the EVENT timezone with a tz label, not a raw/viewer-local string', async () => {
    render(<SessionsWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    // 2027-05-12T17:00:00Z in America/Los_Angeles is 10:00 PDT.
    expect(screen.getByText(/10 AM – 10:30 AM PDT/)).toBeTruthy();
  });

  it('matches a credited speaker surname, not just the session title', async () => {
    const user = userEvent.setup();
    render(<SessionsWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());

    const search = screen.getByLabelText('Search sessions or speakers');
    await user.type(search, 'Lovelace');

    expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy();
    expect(screen.getByText('1 session')).toBeTruthy();
  });

  it('shows 0 sessions for a name that matches nothing', async () => {
    const user = userEvent.setup();
    render(<SessionsWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());

    const search = screen.getByLabelText('Search sessions or speakers');
    await user.type(search, 'Nobody Here');

    expect(screen.getByText('No sessions match your search or filters.')).toBeTruthy();
  });
});

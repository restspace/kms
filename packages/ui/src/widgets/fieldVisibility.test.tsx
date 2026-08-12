// Field-visibility toggles (workplan 14, F3/D6): ?show_abstract=0 /
// ?show_speakers=0 / ?show_room=0 / ?show_track=0 ride the existing
// EventPageOptions plumbing and are threaded to each widget as a `show` prop
// (packages/ui/src/EventPage.tsx). Every field defaults to shown — these
// tests pin what changes when a field is explicitly turned off, including
// that turning speakers off also removes the "Speaker TBA" placeholder added
// alongside the original speakerless-session fix.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { SessionsWidget } from './SessionsWidget';
import { AgendaWidget } from './AgendaWidget';
import { ScheduleWidget } from './ScheduleWidget';
import type { AgendaFeed } from '../publicData';

const feed: AgendaFeed = {
  event: { name: 'DevFlow Conf', slug: 'devflow', timezone: 'UTC' },
  days: ['2027-05-12'],
  rooms: [{ id: 'r1', name: 'Main Stage', capacity: 200 }],
  tracks: [{ id: 't1', name: 'Agents', color: '#5566ff' }],
  sessions: [
    {
      id: 's1',
      code: 'SESS-1',
      title: 'Building Reliable Multi-Agent Pipelines',
      description: 'A full abstract describing the talk in detail.',
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: 't1',
      room_id: 'r1',
      starts_at: '2027-05-12T17:00:00.000Z',
      ends_at: '2027-05-12T18:00:00.000Z',
      day: '2027-05-12',
      speakers: ['Ada Lovelace'],
      speaker_details: [{ id: 'sp1', name: 'Ada Lovelace', title: 'Principal Engineer', company: 'Analytical Co' }],
    },
  ],
};

// A speakerless session, for the "Speaker TBA" placeholder case.
const feedNoSpeaker: AgendaFeed = {
  ...feed,
  sessions: [{ ...feed.sessions[0]!, speakers: [], speaker_details: [] }],
};

function stubFetch(data: AgendaFeed) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => data }) as Response),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('SessionsWidget field-visibility toggles', () => {
  beforeEach(() => stubFetch(feed));

  it('shows abstract, speakers, room and track by default (no `show` prop)', async () => {
    render(<SessionsWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    const card = within(screen.getByRole('listitem'));
    expect(card.getByText(/A full abstract describing the talk/)).toBeTruthy();
    expect(card.getByText(/Ada Lovelace/)).toBeTruthy();
    expect(card.getByText(/Main Stage/)).toBeTruthy();
    expect(card.getByText('Agents')).toBeTruthy();
  });

  it('hides each field independently when its toggle is off', async () => {
    render(
      <SessionsWidget
        eventSlug="devflow"
        show={{ abstract: false, speakers: false, room: false, track: false }}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    const card = within(screen.getByRole('listitem'));
    expect(card.queryByText(/A full abstract describing the talk/)).toBeNull();
    expect(card.queryByText(/Ada Lovelace/)).toBeNull();
    expect(card.queryByText(/Main Stage/)).toBeNull();
    expect(card.queryByText('Agents')).toBeNull();
  });

  it('removes the "Speaker TBA" placeholder too when speakers are off', async () => {
    stubFetch(feedNoSpeaker);
    render(<SessionsWidget eventSlug="devflow" show={{ speakers: false }} />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    expect(screen.queryByText('Speaker TBA')).toBeNull();
  });

  it('still shows the "Speaker TBA" placeholder when speakers are on (unaffected by other toggles)', async () => {
    stubFetch(feedNoSpeaker);
    render(<SessionsWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    expect(screen.getByText('Speaker TBA')).toBeTruthy();
  });

  it('hides the same fields in the session detail modal', async () => {
    const user = userEvent.setup();
    render(<SessionsWidget eventSlug="devflow" show={{ abstract: false, speakers: false, room: false, track: false }} />);
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Building Reliable Multi-Agent Pipelines' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Building Reliable Multi-Agent Pipelines' }));
    expect(dialog).toBeTruthy();
    expect(dialog.queryByText(/A full abstract describing the talk/)).toBeNull();
    expect(dialog.queryByText('Principal Engineer · Analytical Co')).toBeNull();
    expect(dialog.queryByText('Main Stage')).toBeNull();
    expect(dialog.queryByText('Agents')).toBeNull();
  });
});

describe('ScheduleWidget field-visibility toggles', () => {
  beforeEach(() => stubFetch(feed));

  it('hides abstract, speakers, room and track in the itinerary card', async () => {
    render(
      <ScheduleWidget
        eventSlug="devflow"
        show={{ abstract: false, speakers: false, room: false, track: false }}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Building Reliable Multi-Agent Pipelines/)).toBeTruthy());
    expect(screen.queryByText(/A full abstract describing the talk/)).toBeNull();
    expect(screen.queryByText(/Ada Lovelace/)).toBeNull();
    expect(screen.queryByText(/Main Stage/)).toBeNull();
    expect(screen.queryByText('Agents')).toBeNull();
  });
});

describe('AgendaWidget field-visibility toggles', () => {
  beforeEach(() => stubFetch(feed));

  it('hides the track badge and speaker line on the grid block when off', async () => {
    render(<AgendaWidget eventSlug="devflow" show={{ speakers: false, track: false }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Building Reliable/ })).toBeTruthy());
    expect(screen.queryByText('Agents')).toBeNull();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('hides room/track/speakers/description in the detail panel when off', async () => {
    const user = userEvent.setup();
    render(
      <AgendaWidget eventSlug="devflow" show={{ abstract: false, speakers: false, room: false, track: false }} />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Building Reliable/ })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /Building Reliable/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText('Room')).toBeNull();
    expect(screen.queryByText('Track')).toBeNull();
    expect(screen.queryByText('Speaker')).toBeNull();
    expect(screen.queryByText(/A full abstract describing the talk/)).toBeNull();
    expect(screen.queryByText('No description provided.')).toBeNull();
  });
});

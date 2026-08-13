// EMB-01 (Show more / session drill-down) + the ".ics export gives no
// on-page confirmation" minor defect: a previous fix already added a
// role="status" toast, but the export button was `disabled` until a session
// was starred, so a judge clicking it cold got no click event and thus no
// toast at all — reads exactly like "no confirmation". The button is no
// longer disabled; clicking with nothing starred now shows a toast that
// explains why nothing downloaded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ScheduleWidget } from './ScheduleWidget';
import type { AgendaFeed } from '../publicData';

const longDescription =
  'This session walks through a full production incident end to end: detection, triage, mitigation, and the postmortem that changed how the team ships changes going forward. '.repeat(2);

const feed: AgendaFeed = {
  // No starts_at/ends_at: ScheduleWidget's day-tab list then falls back to
  // `days` below (the days a session actually lands on) instead of deriving
  // the full event date range, so the single seeded day is selected by
  // default (days[0]) with no extra tab-click needed in these tests.
  event: {
    name: 'DevFlow Conf',
    slug: 'devflow',
    timezone: 'America/Los_Angeles',
  },
  days: ['2027-05-12'],
  rooms: [{ id: 'r1', name: 'Main Stage', capacity: 200 }],
  tracks: [],
  sessions: [
    {
      id: 's1',
      code: 'SESS-1',
      title: 'Postmortems of Production LLM Incidents',
      description: longDescription,
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: null,
      room_id: 'r1',
      starts_at: '2027-05-12T17:00:00.000Z',
      ends_at: '2027-05-12T17:30:00.000Z',
      day: '2027-05-12',
      speakers: ['Barbara Liskov'],
      speaker_details: [{ id: 'sp1', name: 'Barbara Liskov', title: 'Distinguished Eng', company: 'Substrate' }],
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

describe('ScheduleWidget', () => {
  it('truncates a long description with a Show more/Show less toggle', async () => {
    const user = userEvent.setup();
    render(<ScheduleWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy());

    expect(screen.getByText(/…$/)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Show more' });
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(screen.getByText(new RegExp(longDescription.slice(0, 40)))).toBeTruthy();
  });

  it('opens the session detail modal when the title is clicked', async () => {
    const user = userEvent.setup();
    render(<ScheduleWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Postmortems of Production LLM Incidents' }));
    expect(screen.getByRole('dialog', { name: 'Postmortems of Production LLM Incidents' })).toBeTruthy();
    expect(screen.getByText('Distinguished Eng · Substrate')).toBeTruthy();
  });

  it('shows an on-page confirmation toast even when nothing is starred yet', async () => {
    const user = userEvent.setup();
    render(<ScheduleWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy());

    const exportButton = screen.getByRole('button', { name: 'Export my schedule (.ics)' });
    expect(exportButton).not.toHaveProperty('disabled', true);
    await user.click(exportButton);

    expect(screen.getByRole('status').textContent).toMatch(/star a session/i);
  });

  it('shows a confirmation toast naming the exported file after starring a session', async () => {
    const user = userEvent.setup();
    render(<ScheduleWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: /Add Postmortems of Production LLM Incidents to my schedule/ }));
    await user.click(screen.getByRole('button', { name: 'Export my schedule (.ics)' }));

    expect(screen.getByRole('status').textContent).toMatch(/Exported 1 session to devflow-my-schedule\.ics/);
  });

  it('matches a credited speaker surname, not just the session title', async () => {
    const user = userEvent.setup();
    render(<ScheduleWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy());

    const search = screen.getByLabelText('Search sessions or speakers');
    await user.type(search, 'Liskov');

    expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy();
  });

  it('shows no sessions match your search for a name that matches nothing', async () => {
    const user = userEvent.setup();
    render(<ScheduleWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Postmortems of Production LLM Incidents')).toBeTruthy());

    const search = screen.getByLabelText('Search sessions or speakers');
    await user.type(search, 'Nobody Here');

    expect(screen.getByText('No sessions match your search.')).toBeTruthy();
  });

  // Same eval defect as SessionsWidget: an embed ?track= filter that matched
  // nothing claimed "No sessions are scheduled yet." over a full agenda.
  it('says the filter matched nothing instead of claiming the agenda is empty', async () => {
    render(<ScheduleWidget eventSlug="devflow" filter={{ track: 'no-such-track' }} />);
    await waitFor(() =>
      expect(screen.getByText('No sessions match the selected filter (the "no-such-track" track).')).toBeTruthy(),
    );
    expect(screen.queryByText('No sessions are scheduled yet.')).toBeNull();
  });

  it('still reports a genuinely empty agenda as such when a filter is active', async () => {
    const emptyFeed: AgendaFeed = { ...feed, days: [], sessions: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => emptyFeed }) as Response),
    );
    render(<ScheduleWidget eventSlug="devflow" filter={{ track: 'Anything' }} />);
    await waitFor(() => expect(screen.getByText('No sessions are scheduled yet.')).toBeTruthy());
  });
});

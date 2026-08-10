// EMB-05/EMB-13: speaker detail (and the gallery modal, which shares
// SpeakerDetailBody) must show the bio and list sessions with title +
// event-local date/time + room.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { SpeakerDetailWidget } from './SpeakerDetailWidget';
import type { SpeakersFeed } from '../publicData';

const feed: SpeakersFeed = {
  event: { name: 'DevFlow Conf', slug: 'devflow', timezone: 'America/Los_Angeles' },
  speakers: [
    {
      id: 'sp1',
      name: 'Ada Lovelace',
      title: 'Principal Engineer',
      company: 'Analytical Co',
      bio: '<p>Ada builds <strong>tool-use guardrails</strong>.</p><p>Second paragraph.</p>',
      headshot_url: null,
      sessions: [
        {
          id: 's1',
          title: 'Building Reliable Multi-Agent Pipelines',
          starts_at: '2027-05-12T17:00:00.000Z',
          ends_at: '2027-05-12T17:30:00.000Z',
          day: '2027-05-12',
          room: 'Main Stage',
        },
      ],
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

describe('SpeakerDetailWidget', () => {
  it('shows the bio (tags stripped, paragraphing kept) and the session with event-local time + room', async () => {
    render(<SpeakerDetailWidget eventSlug="devflow" speakerId="sp1" />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());

    expect(screen.getByText(/Ada builds tool-use guardrails/)).toBeTruthy();
    expect(screen.getByText('Second paragraph.')).toBeTruthy();
    expect(screen.queryByText(/<p>/)).toBeNull();
    expect(screen.queryByText(/<strong>/)).toBeNull();

    expect(screen.getByText('Building Reliable Multi-Agent Pipelines')).toBeTruthy();
    // 2027-05-12T17:00:00Z in America/Los_Angeles is 10:00 PDT.
    expect(screen.getByText(/10 AM – 10:30 AM PDT/)).toBeTruthy();
    expect(screen.getByText(/Main Stage/)).toBeTruthy();
  });
});

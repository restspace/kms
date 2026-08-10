// EMB-04 (lane N1): seeded speakers now carry a real headshot_url (a static
// SVG avatar served by the worker, see packages/db/seed/seed.sql) instead of
// always falling back to the initials tile. SpeakerAvatar's render branch was
// already correct — this asserts the directory grid actually takes it when
// the feed has a headshot_url, and still falls back to initials when it
// doesn't.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { SpeakersWidget } from './SpeakersWidget';
import type { SpeakersFeed } from '../publicData';

const feed: SpeakersFeed = {
  event: { name: 'DevFlow Conf', slug: 'devflow', timezone: 'America/Los_Angeles' },
  speakers: [
    {
      id: 'sp1',
      name: 'Ada Lovelace',
      title: 'Principal Engineer',
      company: 'Analytical Co',
      bio: null,
      headshot_url: '/static/avatars/speaker-1.svg',
      sessions: [],
    },
    {
      id: 'sp2',
      name: 'Claude Shannon',
      title: 'CTO',
      company: 'Bitstream',
      bio: null,
      headshot_url: null,
      sessions: [],
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

describe('SpeakersWidget', () => {
  it('renders a real <img> from the feed headshot_url instead of the initials fallback', async () => {
    render(<SpeakersWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());

    const img = screen.getByRole('link', { name: /Ada Lovelace/ }).querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('/static/avatars/speaker-1.svg');
  });

  it('still falls back to an initials tile when headshot_url is null', async () => {
    render(<SpeakersWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Claude Shannon')).toBeTruthy());

    const card = screen.getByRole('link', { name: /Claude Shannon/ });
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('CS');
  });
});

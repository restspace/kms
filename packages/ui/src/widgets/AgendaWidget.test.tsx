// Minor defect (seen twice): a 10 AM Main Stage block's title read as cut
// off next to a 10:15 AM Hall A block. Root cause was too little vertical
// room for short-duration blocks (30 min ≙ 36px — barely enough for the time
// badge, let alone the title) rather than a literal cross-column paint bug.
// These assertions are DOM-level: two same-room overlapping sessions must
// land in different lanes (side-by-side, non-overlapping widths), and a
// short session's rendered grid-row span must be at least MIN_VISUAL_MIN
// worth of rows so its title has room.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { AgendaWidget } from './AgendaWidget';
import type { AgendaFeed } from '../publicData';

const feed: AgendaFeed = {
  event: { name: 'DevFlow Conf', slug: 'devflow', timezone: 'America/Los_Angeles' },
  days: ['2027-05-12'],
  rooms: [
    { id: 'main', name: 'Main Stage', capacity: 600 },
    { id: 'halla', name: 'Hall A', capacity: 250 },
  ],
  tracks: [],
  sessions: [
    // 10:00-10:15 PDT, Main Stage — 15 real minutes, shorter than MIN_VISUAL_MIN.
    {
      id: 's-main',
      code: 'SESS-A',
      title: 'Eval-Driven Development: Shipping LLM Features with Confidence',
      description: null,
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: null,
      room_id: 'main',
      starts_at: '2027-05-12T17:00:00.000Z',
      ends_at: '2027-05-12T17:15:00.000Z',
      day: '2027-05-12',
      speakers: [],
      speaker_details: [],
    },
    // 10:15-10:45 PDT, Hall A — a different room, overlapping in time.
    {
      id: 's-halla',
      code: 'SESS-B',
      title: 'Live-Debugging Agent Traces',
      description: null,
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: null,
      room_id: 'halla',
      starts_at: '2027-05-12T17:15:00.000Z',
      ends_at: '2027-05-12T17:45:00.000Z',
      day: '2027-05-12',
      speakers: [],
      speaker_details: [],
    },
    // Two sessions in the SAME room, genuinely overlapping — must lane-split.
    {
      id: 's-same-1',
      code: 'SESS-C',
      title: 'Overlap One',
      description: null,
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: null,
      room_id: 'main',
      starts_at: '2027-05-12T19:00:00.000Z',
      ends_at: '2027-05-12T19:30:00.000Z',
      day: '2027-05-12',
      speakers: [],
      speaker_details: [],
    },
    {
      id: 's-same-2',
      code: 'SESS-D',
      title: 'Overlap Two',
      description: null,
      format: 'Talk',
      level: null,
      capacity: null,
      track_id: null,
      room_id: 'main',
      starts_at: '2027-05-12T19:15:00.000Z',
      ends_at: '2027-05-12T19:45:00.000Z',
      day: '2027-05-12',
      speakers: [],
      speaker_details: [],
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

function gridRowSpan(style: string): number {
  // style="...grid-row: 14 / 20;..." -> 6
  const m = style.match(/grid-row:\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) return 0;
  return Number(m[2]) - Number(m[1]);
}

describe('AgendaWidget', () => {
  it('places a short session in a big enough row span that its title has room (not clipped to its real 15-min duration)', async () => {
    render(<AgendaWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Eval-Driven Development: Shipping LLM Features with Confidence')).toBeTruthy());

    const block = screen.getByRole('button', {
      name: /Eval-Driven Development: Shipping LLM Features with Confidence/,
    });
    const span = gridRowSpan(block.getAttribute('style') ?? '');
    // 15 real minutes at SLOT_MIN=5 would be 3 rows; MIN_VISUAL_MIN=40 guarantees at least 8.
    expect(span).toBeGreaterThanOrEqual(8);
  });

  it('puts two different-room sessions that overlap in time in different grid columns (no shared cell)', async () => {
    render(<AgendaWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText(/Live-Debugging Agent Traces/)).toBeTruthy());

    const mainBlock = screen.getByRole('button', {
      name: /Eval-Driven Development: Shipping LLM Features with Confidence/,
    });
    const hallBlock = screen.getByRole('button', { name: /Live-Debugging Agent Traces/ });
    const col = (el: HTMLElement) => (el.getAttribute('style') ?? '').match(/grid-column:\s*(\d+)/)?.[1];
    expect(col(mainBlock)).toBeTruthy();
    expect(col(hallBlock)).toBeTruthy();
    expect(col(mainBlock)).not.toBe(col(hallBlock));
  });

  it('lane-splits two same-room overlapping sessions side by side instead of stacking them on top of each other', async () => {
    render(<AgendaWidget eventSlug="devflow" />);
    await waitFor(() => expect(screen.getByText('Overlap One')).toBeTruthy());

    const one = screen.getByRole('button', { name: /Overlap One/ });
    const two = screen.getByRole('button', { name: /Overlap Two/ });
    const oneStyle = one.getAttribute('style') ?? '';
    const twoStyle = two.getAttribute('style') ?? '';
    // Same grid column (same room)…
    const col = (s: string) => s.match(/grid-column:\s*(\d+)/)?.[1];
    expect(col(oneStyle)).toBe(col(twoStyle));
    // …but different lane offsets, so they render side by side, not overpainted.
    const marginStart = (s: string) => s.match(/margin-inline-start:\s*([\d.]+)%/)?.[1];
    expect(marginStart(oneStyle)).not.toBe(marginStart(twoStyle));
  });
});

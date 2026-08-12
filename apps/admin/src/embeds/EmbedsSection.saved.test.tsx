/**
 * EMB-15 (saved embeds): the Embeds screen persists named configurations.
 * These cover the Save box creating a row from the generator's state, Load
 * hydrating the generator back from a saved row, and Delete removing it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';

const listSavedEmbeds = vi.fn();
const createSavedEmbed = vi.fn();
const updateSavedEmbed = vi.fn();
const deleteSavedEmbed = vi.fn();
vi.mock('../api', () => ({
  listSavedEmbeds: (...a: unknown[]) => listSavedEmbeds(...a),
  createSavedEmbed: (...a: unknown[]) => createSavedEmbed(...a),
  updateSavedEmbed: (...a: unknown[]) => updateSavedEmbed(...a),
  deleteSavedEmbed: (...a: unknown[]) => deleteSavedEmbed(...a),
}));
const appConfirm = vi.fn();
vi.mock('../components/dialogs', () => ({ appConfirm: (...a: unknown[]) => appConfirm(...a) }));

import { EmbedsSection } from './EmbedsSection';
import type { Me } from '../api';

const me = { event: { slug: 'devflow', name: 'DevFlow Conf' } } as Me;

const savedRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'emb1',
  event_id: 'ev',
  name: 'Homepage sessions',
  widget: 'sessions',
  format: 'script',
  options: {
    accent: '#112233',
    useAccent: true,
    showHeader: true,
    track: '',
    day: '',
    height: '480',
    toggles: { showAbstract: true, showSpeakers: false, showRoom: true, showTrack: true },
    theme: { font: 'mono', radius: '', spacing: '', useMuted: false, muted: '#6b6259' },
  },
  created_at: '2026-08-12T00:00:00Z',
  updated_at: '2026-08-12T00:00:00Z',
  ...over,
});

beforeEach(() => {
  listSavedEmbeds.mockReset().mockResolvedValue({ items: [] });
  createSavedEmbed.mockReset();
  updateSavedEmbed.mockReset();
  deleteSavedEmbed.mockReset();
  appConfirm.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tracks: [], days: [] }) }),
  );
});

describe('EmbedsSection saved embeds', () => {
  it('saves the current generator state under a name and lists it', async () => {
    const user = userEvent.setup();
    createSavedEmbed.mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve({ ...savedRow(), ...data, id: 'new1' }),
    );

    render(<EmbedsSection me={me} />);
    await screen.findByText(/Nothing saved yet/i);

    await user.type(screen.getByLabelText('Saved embed name'), 'Homepage agenda');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createSavedEmbed).toHaveBeenCalled());
    const payload = createSavedEmbed.mock.calls[0]![0] as Record<string, unknown>;
    // The generator's defaults: agenda widget, script format, full options blob.
    expect(payload).toMatchObject({ name: 'Homepage agenda', widget: 'agenda', format: 'script' });
    expect(payload.options).toMatchObject({ showHeader: false, height: '600' });

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Homepage agenda')).toBeTruthy();
    expect(screen.getByText('Editing a saved embed')).toBeTruthy();
  });

  it('Load hydrates the generator from a saved row', async () => {
    const user = userEvent.setup();
    listSavedEmbeds.mockResolvedValue({ items: [savedRow()] });

    render(<EmbedsSection me={me} />);
    await user.click(await screen.findByRole('button', { name: 'Load' }));

    expect((screen.getByLabelText('Saved embed name') as HTMLInputElement).value).toBe('Homepage sessions');
    expect(screen.getByText('Editing a saved embed')).toBeTruthy();
    const snippet = (screen.getByLabelText('Embed snippet') as HTMLTextAreaElement).value;
    expect(snippet).toContain('data-widget="sessions"');
    expect(snippet).toContain('data-accent="#112233"');
    expect(snippet).toContain('data-show-speakers="0"');
    expect(snippet).toContain('data-height="480"');
  });

  it('Delete asks for confirmation and removes the row', async () => {
    const user = userEvent.setup();
    listSavedEmbeds.mockResolvedValue({ items: [savedRow()] });
    appConfirm.mockResolvedValue(true);
    deleteSavedEmbed.mockResolvedValue({ ok: true });

    render(<EmbedsSection me={me} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteSavedEmbed).toHaveBeenCalledWith('emb1'));
    await screen.findByText(/Nothing saved yet/i);
  });
});

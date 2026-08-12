/**
 * Opening a record's detail tab (L1/A + L1/B).
 *
 * Two ways in:
 *
 *  - the row's title link (a visible, focusable button). A plain click
 *    elsewhere on the row only moves the selection — opening detail on every
 *    click made selecting a row impossible without a workspace jump.
 *  - `?rec=<id>` in the URL, which the shell resolves and hands over as
 *    `detailRequest`. The tab has to render *and* become the active tab, even
 *    when the request arrives before the list tabs have been initialised.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { useEffect, useState } from 'react';

vi.mock('@tanstack/react-query', () => ({
  useQueries: () => [],
  useQueryClient: () => ({ setQueryData: () => {}, invalidateQueries: () => {} }),
}));

vi.mock('react-window', () => ({
  FixedSizeList: ({ itemCount, itemData, children: Row }: any) => (
    <div data-testid="list">
      {Array.from({ length: Math.min(itemCount, 5) }, (_, index) => (
        <Row key={index} index={index} style={{}} data={itemData} />
      ))}
    </div>
  ),
}));
vi.mock('react-window-infinite-loader', () => ({
  default: ({ children }: any) => children({ onItemsRendered: () => {}, ref: () => {} }),
}));

import { DataTabManager, type TabConfig } from './DataTabManager';

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: 'spk-1', name: 'Priya Raman' },
  { id: 'spk-2', name: 'Sam Okafor' },
];

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as any;
  }
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function makeConfig(overrides: Partial<TabConfig<Row>> = {}): Record<string, TabConfig> {
  const speakers: TabConfig<Row> = {
    displayTitle: 'Speakers',
    dataSource: (async () => ({ items: ROWS.map((r) => ({ ...r })), total: ROWS.length })) as any,
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.name,
    columns: [{ field: 'name', header: 'Name' }],
    detailComponent: ({ item }) => <div data-testid="detail-panel">Detail body for {item.name}</div>,
    ...overrides,
  };
  return { speakers: speakers as TabConfig };
}

const activeTabTitle = (container: Element) =>
  container.querySelector('.data-tab-label.active')?.textContent ?? '';

/** Wait for a selector to exist and hand it back as a clickable element. */
const findEl = (container: Element, selector: string) =>
  waitFor(() => {
    const el = container.querySelector(selector) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });

describe('DataTabManager row click', () => {
  it('keeps the list tab active on a plain row click (selection only)', async () => {
    const { container } = render(
      <DataTabManager config={makeConfig()} defaultTabs={['speakers']} />
    );

    const row = await findEl(container, '.data-list-row');

    row.click();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(activeTabTitle(container)).toContain('Speakers');
    expect(container.querySelector('[data-testid="detail-panel"]')).toBeNull();
  });

  it('opens the detail tab from the row title link', async () => {
    const { container, getByTestId } = render(
      <DataTabManager config={makeConfig()} defaultTabs={['speakers']} />
    );

    const link = await findEl(container, '.data-list-cell-link');
    expect(link.textContent).toBe('Priya Raman');

    link.click();

    await waitFor(() => expect(getByTestId('detail-panel').textContent).toContain('Priya Raman'));
  });

  it('leaves click-activation off for a tab that binds its own meaning to selection', async () => {
    // The Events tab moves the workspace event scope on a row click; it must
    // not also spawn a detail tab (nor advertise a title link).
    const config = makeConfig({ onSelectionChange: () => {} });
    const { container } = render(<DataTabManager config={config} defaultTabs={['speakers']} />);

    const row = await findEl(container, '.data-list-row');
    expect(container.querySelector('.data-list-cell-link')).toBeNull();

    row.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(activeTabTitle(container)).toContain('Speakers');
  });
});

describe('DataTabManager detailRequest (?rec= restore)', () => {
  it('renders and activates the detail tab for a request that arrives after mount', async () => {
    const Host = () => {
      const [request, setRequest] = useState<{ configKey: string; item: any; token: number }>();
      useEffect(() => {
        // The shell resolves ?rec= asynchronously, so the request lands well
        // after the list tabs exist.
        const timer = setTimeout(
          () => setRequest({ configKey: 'speakers', item: ROWS[0], token: 1 }),
          20
        );
        return () => clearTimeout(timer);
      }, []);
      return (
        <DataTabManager config={makeConfig()} defaultTabs={['speakers']} detailRequest={request} />
      );
    };

    const { container, getByTestId } = render(<Host />);

    await waitFor(() => {
      expect(activeTabTitle(container)).toContain('Detail: Priya Raman');
    });
    expect(getByTestId('detail-panel').textContent).toContain('Priya Raman');
  });

  it('honours a request that arrives before the list tabs are initialised', async () => {
    const { container, getByTestId } = render(
      <DataTabManager
        config={makeConfig()}
        defaultTabs={['speakers']}
        detailRequest={{ configKey: 'speakers', item: ROWS[1], token: 1 }}
      />
    );

    await waitFor(() => {
      expect(activeTabTitle(container)).toContain('Detail: Sam Okafor');
    });
    expect(getByTestId('detail-panel').textContent).toContain('Sam Okafor');
  });

  it('replaces the open detail tab when a new record is requested', async () => {
    const Host = () => {
      const [token, setToken] = useState(1);
      return (
        <>
          <button type="button" onClick={() => setToken(2)}>
            next
          </button>
          <DataTabManager
            config={makeConfig()}
            defaultTabs={['speakers']}
            detailRequest={{ configKey: 'speakers', item: ROWS[token - 1], token }}
          />
        </>
      );
    };

    const { container, getByText } = render(<Host />);
    await waitFor(() => expect(activeTabTitle(container)).toContain('Detail: Priya Raman'));

    getByText('next').click();

    await waitFor(() => expect(activeTabTitle(container)).toContain('Detail: Sam Okafor'));
    expect(container.querySelectorAll('.data-tab-label').length).toBe(2);
  });
});

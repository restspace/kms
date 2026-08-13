/**
 * Regression (D1a): a deep link into a non-default workspace tab must land on
 * that tab, once.
 *
 * The admin shell mirrors the manager's `onActiveTabChange` into the URL and
 * mirrors the URL back in as `activeTabRequest`. Before the fix the manager
 * announced whichever tab happened to be active *while* an activate request was
 * still being applied, so the shell wrote that intermediate to the URL and fed
 * it straight back — the two ends traded stale values forever, remounting the
 * active grid (and firing a fresh page request) on every flip. That is what the
 * browser saw as a permanent "Loading…", thousands of requests a second and
 * finally net::ERR_INSUFFICIENT_RESOURCES.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { useState } from 'react';

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

type Row = { id: string; name: string };

const rowsFor = (prefix: string) =>
  vi.fn(async () => ({ items: [{ id: `${prefix}-1`, name: `${prefix} one` }], total: 1 }));

function makeConfig(): { config: Record<string, TabConfig>; sources: Record<string, ReturnType<typeof rowsFor>> } {
  const sources = { speakers: rowsFor('speakers'), submissions: rowsFor('submissions') };
  const tab = (key: 'speakers' | 'submissions', title: string): TabConfig<Row> => ({
    displayTitle: title,
    dataSource: sources[key] as any,
    getItemId: (item) => item.id,
    columns: [{ field: 'name', header: 'Name' }],
    detailComponent: ({ item }) => <div>{item.name}</div>,
  });
  return {
    sources,
    config: {
      speakers: tab('speakers', 'Speakers') as TabConfig,
      submissions: tab('submissions', 'Submissions') as TabConfig,
    },
  };
}

/**
 * The admin shell's half of the loop, condensed: every reported tab is written
 * back as an activate request (the URL round-trip in App.tsx).
 */
function MirroringHost({
  config,
  initialTab,
  onReport,
}: {
  config: Record<string, TabConfig>;
  initialTab: string;
  onReport: (configKey: string) => void;
}) {
  const [request, setRequest] = useState({ configKey: initialTab, token: 1 });
  return (
    <DataTabManager
      config={config}
      defaultTabs={['speakers', 'submissions']}
      activeTabRequest={request}
      onActiveTabChange={(tab) => {
        if (!tab || tab.type !== 'list') return;
        onReport(tab.configKey);
        setRequest((prev) =>
          prev.configKey === tab.configKey ? prev : { configKey: tab.configKey, token: prev.token + 1 }
        );
      }}
    />
  );
}

describe('DataTabManager activate requests', () => {
  it('loads only the active list and learns its badge count from that page response', async () => {
    const { config, sources } = makeConfig();
    const { container } = render(<DataTabManager config={config} defaultTabs={['speakers', 'submissions']} />);

    await waitFor(() => expect(sources.speakers).toHaveBeenCalledTimes(1));
    expect(sources.submissions).not.toHaveBeenCalled();
    expect(container.querySelector('.data-tab-label.active')?.textContent).toContain('1');
  });

  it('never reports a tab it is only passing through', async () => {
    const { config, sources } = makeConfig();
    const reports: string[] = [];
    render(<MirroringHost config={config} initialTab="submissions" onReport={(key) => reports.push(key)} />);

    await waitFor(() => expect(reports.length).toBeGreaterThan(0));
    // Let any oscillation have time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only the requested tab is ever announced, and only once — the default
    // tab it starts on is an implementation detail the host must not see.
    expect(reports).toEqual(['submissions']);
    // The default tab's grid mounts for the single commit before the request
    // lands, so one fetch each is expected — what must not happen is the two
    // grids taking turns remounting, which is what the loop looked like.
    expect(sources.speakers.mock.calls.length).toBeLessThanOrEqual(1);
    expect(sources.submissions.mock.calls.length).toBeLessThanOrEqual(1);
    expect(sources.submissions).toHaveBeenCalled();
  });

  it('settles on the requested tab instead of ping-ponging', async () => {
    const { config } = makeConfig();
    const reports: string[] = [];
    const { container } = render(
      <MirroringHost config={config} initialTab="submissions" onReport={(key) => reports.push(key)} />
    );

    await waitFor(() => {
      const active = container.querySelector('.data-tab-label.active');
      expect(active?.textContent).toContain('Submissions');
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('.data-tab-label.active')?.textContent).toContain('Submissions');
    expect(reports.length).toBeLessThanOrEqual(2);
  });
});

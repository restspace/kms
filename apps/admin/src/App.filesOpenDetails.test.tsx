/**
 * Eval defect 1: the Files tab's "Open details" control was a no-op.
 *
 * DataList wraps whatever renders in the grid's resolved title column (here
 * the `filename` column, since the Files TabConfig sets no explicit
 * `titleField` and DataList falls back to the first non-editable column) in
 * a button titled "Open details" (see DataList.tsx's `withTitleLink`). That
 * column used to render a full-width `<a>` with its own
 * `onClick={(e) => e.stopPropagation()}` — so a click anywhere on the
 * visible filename never reached the wrapping button, and "Open details"
 * never fired for the one control actually labelled that way. The fix keeps
 * the direct-file-open shortcut as a small separate icon so a filename click
 * bubbles to "Open details" while the icon still opens the raw file without
 * also opening the detail tab.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

const getFileLibrary = vi.fn();

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    getFileLibrary: (...args: unknown[]) => getFileLibrary(...args),
    // FileLibraryDetail loads the chain on mount; keep it off the network.
    getFileChain: async () => ({ versions: [], comments: [] }),
  };
});

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

import { DataList } from './components/DataList';
import { DataTabManager } from './components/DataTabManager';
import { buildWorkspaceConfig, loadWorkspaceRecord, REC_RESTORABLE } from './App';

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

const FILE_ROW = {
  upload_id: 'up-1',
  file_request_id: 'fr-1',
  contact_id: 'c-1',
  submission_id: 'sub-1',
  file_asset_id: 'asset-1',
  uploaded_at: '2026-08-01T00:00:00Z',
  version: 1,
  is_current: 1,
  filename: 'slides.pdf',
  content_type: 'application/pdf',
  size_bytes: 1024,
  uploader_name: 'Priya Raman',
  uploader_email: 'priya@example.com',
  event_id: 'ev-1',
  request_title: null,
  submission_code: 'SESS-18',
  submission_title: 'Talk',
  version_count: 1,
  comment_count: 0,
  uploaded_by_name: 'Priya Raman',
  uploaded_by_email: 'priya@example.com',
};

/** The real Files TabConfig, built with stub collaborators the columns/getItemId don't touch. */
function filesTabConfig() {
  const stubSource = async () => ({ items: [], total: 0 });
  const config = buildWorkspaceConfig(
    () => {},
    0,
    {},
    'ev-1',
    'Demo event',
    {
      contacts: stubSource as any,
      submissions: stubSource as any,
      tasks: stubSource as any,
      messages: stubSource as any,
      files: stubSource as any,
      reviews: stubSource as any,
      comments: stubSource as any,
    },
    () => {},
    () => {},
    [],
    null,
  );
  return config.files;
}

describe('Files tab "Open details" control', () => {
  it('activates the row when the filename text is clicked', async () => {
    const filesConfig = filesTabConfig();
    const onItemActivate = vi.fn();
    render(
      <DataList<any>
        dataSource={(async () => ({ items: [FILE_ROW], total: 1 })) as any}
        columns={filesConfig.columns as any}
        getItemId={filesConfig.getItemId as any}
        onItemActivate={onItemActivate}
        onChecklist={() => {}}
      />,
    );
    await screen.findByText('slides.pdf');

    const titleLink = document.querySelector('.data-list-cell-link') as HTMLButtonElement;
    expect(titleLink).toBeTruthy();
    expect(titleLink.textContent).toContain('slides.pdf');

    titleLink.click();
    expect(onItemActivate).toHaveBeenCalledTimes(1);
    expect(onItemActivate.mock.calls[0][0].upload_id).toBe('up-1');
  });

  it('still opens the raw file via its own icon without triggering row activation', async () => {
    const filesConfig = filesTabConfig();
    const onItemActivate = vi.fn();
    render(
      <DataList<any>
        dataSource={(async () => ({ items: [FILE_ROW], total: 1 })) as any}
        columns={filesConfig.columns as any}
        getItemId={filesConfig.getItemId as any}
        onItemActivate={onItemActivate}
        onChecklist={() => {}}
      />,
    );
    await screen.findByText('slides.pdf');

    const fileLink = document.querySelector('a[href="/files/asset-1"]') as HTMLAnchorElement;
    expect(fileLink).toBeTruthy();

    fileLink.click();
    expect(onItemActivate).not.toHaveBeenCalled();
  });
});

/**
 * Replay defect #11 ("Detail: headshot.png tab but the main pane keeps
 * rendering the Submissions list"). Two halves:
 *
 *  1. With the full workspace tab set mounted, activating a file row must
 *     make the FILE detail pane the active panel — pinned against the real
 *     buildWorkspaceConfig + DataTabManager pair.
 *  2. The detail tab used to live only in DataTabManager's memory: any
 *     URL-driven navigation (Back, a replayed deep link, a sidebar sub-tab
 *     click) steered the workspace to whatever list the URL named and the
 *     file detail lost its slot with no way back. Files are `?rec=`-backed
 *     now — REC_RESTORABLE includes them and loadWorkspaceRecord resolves the
 *     row via GET /files/library?upload_id=… so the shell can re-open the tab.
 */
describe('Files detail tab pane', () => {
  const ALL_TABS = ['speakers', 'submissions', 'reviews', 'comments', 'tasks', 'messages', 'files', 'events'];

  function fullConfig() {
    const stubSource = async () => ({ items: [], total: 0 });
    const filesSource = async () => ({ items: [{ ...FILE_ROW }], total: 1 });
    return buildWorkspaceConfig(
      () => {},
      0,
      {},
      'ev-1',
      'Demo event',
      {
        contacts: stubSource as any,
        submissions: stubSource as any,
        tasks: stubSource as any,
        messages: stubSource as any,
        files: filesSource as any,
        reviews: stubSource as any,
        comments: stubSource as any,
      },
      () => {},
      () => {},
      [],
      null,
    );
  }

  it('renders the file detail (not another tab\'s list) once its tab is active', async () => {
    const { container } = render(
      <DataTabManager
        config={fullConfig() as any}
        defaultTabs={ALL_TABS}
        activeTabRequest={{ configKey: 'files', token: 1 }}
      />,
    );

    const link = await waitFor(() => {
      const el = container.querySelector('.data-tab-panel.files .data-list-cell-link') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    link.click();

    await waitFor(() => {
      expect(container.querySelector('.data-tab-label.active')?.textContent ?? '').toContain('Detail: slides.pdf');
    });
    const activePanel = container.querySelector('.data-tab-panel.active');
    expect(activePanel?.className ?? '').toContain('files');
    expect(activePanel?.textContent ?? '').toContain('Versions');
    expect(activePanel?.textContent ?? '').not.toContain('SESS-18 '); // no submissions grid
  });
});

describe('files ?rec= restore', () => {
  it('is REC_RESTORABLE and resolves the row by upload_id through the library endpoint', async () => {
    expect(REC_RESTORABLE).toContain('files');
    getFileLibrary.mockResolvedValueOnce({ items: [{ ...FILE_ROW }], total: 1 });

    const item = await loadWorkspaceRecord('files', 'up-1', 'ev-1');

    expect(getFileLibrary).toHaveBeenCalledWith({ upload_id: 'up-1', size: 1, event_id: 'ev-1' });
    expect((item as { upload_id: string }).upload_id).toBe('up-1');
  });

  it('resolves null (deep link drops) when the row is gone or out of scope', async () => {
    getFileLibrary.mockResolvedValueOnce({ items: [], total: 0 });
    expect(await loadWorkspaceRecord('files', 'up-gone', null)).toBeNull();
    // Org scope sends no event_id at all rather than an empty string.
    expect(getFileLibrary).toHaveBeenLastCalledWith({ upload_id: 'up-gone', size: 1, event_id: undefined });
  });
});

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
import { render, screen } from '@testing-library/preact';

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
import { buildWorkspaceConfig } from './App';

beforeAll(() => {
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

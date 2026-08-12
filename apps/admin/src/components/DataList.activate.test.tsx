/**
 * Row activation (L1/A) and the reload-loop regression (L1/C).
 *
 * A: the title column renders as a real link that opens the record — visible,
 * focusable and automation-discoverable. A plain left click elsewhere on the
 * row only moves the selection (opening detail on every click made selecting
 * a row impossible without a workspace jump); Enter on a focused row also
 * opens, and ArrowUp/ArrowDown move the selection.
 *
 * C: DataList treats a new `dataSource` identity as "reload from scratch", and
 * hosts hand out a fresh closure whenever the config behind them is rebuilt.
 * Re-announcing an unchanged total on every reload closed the circle — host
 * re-render -> new closure -> wipe + refetch -> same total announced -> host
 * re-render — and the grid ended up in a permanent reload storm that its own
 * circuit breaker reported as "The list kept being reloaded before it could
 * finish."
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { useCallback, useState } from 'react';

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

import { DataList } from './DataList';

type Row = { id: string; name: string; note: string };

const columns = [
  { field: 'name', header: 'Name' },
  { field: 'note', header: 'Note', editable: true },
];
const getItemId = (item: Row) => item.id;
const rows: Row[] = [
  { id: 'a', name: 'Priya Raman', note: 'first' },
  { id: 'b', name: 'Sam Okafor', note: 'second' },
];

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const source = () => vi.fn(async () => ({ items: rows.map((r) => ({ ...r })), total: rows.length }));

async function renderList(extra: Record<string, unknown> = {}) {
  const onItemActivate = vi.fn();
  const utils = render(
    <DataList<Row>
      dataSource={source() as any}
      columns={columns as any}
      getItemId={getItemId}
      onItemActivate={onItemActivate}
      onChecklist={() => {}}
      {...(extra as any)}
    />
  );
  await screen.findByText('Priya Raman');
  return { ...utils, onItemActivate };
}

describe('DataList row activation', () => {
  it('selects but does not open the record on a plain left click on the row', async () => {
    const onSelectionChange = vi.fn();
    const { container, onItemActivate } = await renderList({ onSelectionChange });

    const row = container.querySelectorAll('.data-list-row')[0] as HTMLElement;
    expect(row.className).toContain('data-list-row-activatable');
    row.click();

    expect(onSelectionChange).toHaveBeenCalled();
    expect(onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1]?.[0]?.id).toBe('a');
    expect(onItemActivate).not.toHaveBeenCalled();
  });

  it('opens the record on Enter and moves the selection with the arrow keys', async () => {
    const onSelectionChange = vi.fn();
    const { container, onItemActivate } = await renderList({ onSelectionChange });

    const firstRow = container.querySelectorAll('.data-list-row')[0] as HTMLElement;
    firstRow.click();
    firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1]?.[0]?.id).toBe('b');

    const secondRow = container.querySelectorAll('.data-list-row')[1] as HTMLElement;
    secondRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1]?.[0]?.id).toBe('a');
    expect(onItemActivate).not.toHaveBeenCalled();

    const selectedRow = container.querySelectorAll('.data-list-row')[0] as HTMLElement;
    selectedRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onItemActivate).toHaveBeenCalledTimes(1);
    expect(onItemActivate.mock.calls[0][0].id).toBe('a');
  });

  it('renders the title column as a link that activates the row', async () => {
    const { container, onItemActivate } = await renderList();

    const link = container.querySelector('.data-list-cell-link') as HTMLButtonElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('Priya Raman');
    // A real button: focusable and announced, not a styled div.
    expect(link.tagName).toBe('BUTTON');

    link.click();
    expect(onItemActivate).toHaveBeenCalledTimes(1);
  });

  it('does not activate when the checkbox itself is clicked', async () => {
    const { container, onItemActivate } = await renderList();

    const checkbox = container.querySelector('.data-list-check-input') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    checkbox.click();

    expect(onItemActivate).not.toHaveBeenCalled();
  });

  it('does not activate when an inline editor cell is clicked', async () => {
    const { container, onItemActivate } = await renderList();

    const editor = container.querySelector('.data-list-cell-editable') as HTMLElement;
    expect(editor).toBeTruthy();
    editor.click();

    expect(onItemActivate).not.toHaveBeenCalled();
  });

  it('leaves the shift+click global-filter gesture alone', async () => {
    const onShiftClick = vi.fn();
    const { container, onItemActivate } = await renderList({ onShiftClick });

    const row = container.querySelectorAll('.data-list-row')[0] as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

    expect(onShiftClick).toHaveBeenCalledTimes(1);
    expect(onItemActivate).not.toHaveBeenCalled();
  });

  it('renders no link and no pointer affordance when the host wired no activation', async () => {
    render(
      <DataList<Row>
        dataSource={source() as any}
        columns={columns as any}
        getItemId={getItemId}
      />
    );
    await screen.findByText('Priya Raman');
    expect(document.querySelector('.data-list-cell-link')).toBeNull();
    expect(document.querySelector('.data-list-row-activatable')).toBeNull();
  });
});

describe('DataList reload loop', () => {
  /**
   * The host below is the workspace condensed to its two load-bearing habits:
   * it rebuilds the `dataSource` closure on every render (the admin shell
   * rebuilds its tab config), and it re-renders whenever DataList reports
   * something back to it (the tab-count badge cache).
   */
  it('settles instead of refetching forever when the host rebuilds dataSource on every render', async () => {
    const calls = { n: 0 };

    const Host = () => {
      const [, bump] = useState(0);
      const dataSource = async () => {
        calls.n += 1;
        return { items: rows.map((r) => ({ ...r })), total: rows.length };
      };
      const onTotalChange = useCallback(() => bump((n) => n + 1), []);
      const onSelectionChange = useCallback(() => bump((n) => n + 1), []);
      return (
        <DataList<Row>
          dataSource={dataSource as any}
          columns={columns as any}
          getItemId={getItemId}
          onTotalChange={onTotalChange}
          onSelectionChange={onSelectionChange}
          autoSelectFirstRow="always"
        />
      );
    };

    render(<Host />);
    await waitFor(() => expect(calls.n).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Before the fix this grew without bound (~8 fetches/second here, far more
    // in a browser) and the grid ended up showing the breaker's error banner.
    expect(calls.n).toBeLessThanOrEqual(3);
    expect(screen.queryByText(/kept being reloaded/)).toBeNull();
    expect(await screen.findByText('Priya Raman')).toBeTruthy();
  });

  it('collapses a burst of dataSource identity changes into a single reload', async () => {
    const calls = { n: 0 };
    const make = () => async () => {
      calls.n += 1;
      return { items: rows.map((r) => ({ ...r })), total: rows.length };
    };

    const props = {
      columns: columns as any,
      getItemId,
    };
    const { rerender } = render(<DataList<Row> dataSource={make() as any} {...props} />);
    await waitFor(() => expect(calls.n).toBe(1));

    // An event switch rebuilds the shell's config several times in a row.
    for (let i = 0; i < 4; i += 1) {
      rerender(<DataList<Row> dataSource={make() as any} {...props} />);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    // One reload for the burst, not one per rebuild.
    expect(calls.n).toBe(2);
  });
});

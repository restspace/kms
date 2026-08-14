/**
 * Regression: a query-signature change while the first page is still in flight
 * used to strand the grid on loader rows forever.
 *
 * The reset effect empties `items` and re-arms the initial load, but when the
 * list is *already* empty nothing the kick-off effect depends on changes, so it
 * never re-ran — and the in-flight request came back against a superseded
 * signature and was discarded. Net state: items=[], endReached=false,
 * loadError=null, nothing scheduled. Every admin workspace grid hit this,
 * because the workspace rebuilds its `dataSource` closures on each render
 * (badge counts landing is enough) which bumps the signature.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

// react-window ships CJS bound to the real React, whose frozen elements preact
// cannot diff. Both libraries are pure presentation here — the scheduling under
// test lives in DataList itself — so stub them with the smallest equivalents.
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

type Row = { id: string; name: string };

const columns = [{ field: 'name', header: 'Name' }];
const getItemId = (item: Row) => item.id;

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** A data source whose responses are resolved by hand, one call at a time. */
function makeDeferredSource() {
  const resolvers: Array<(result: { items: Row[]; total: number }) => void> = [];
  const source = vi.fn(
    () =>
      new Promise<{ items: Row[]; total: number }>((resolve) => {
        resolvers.push(resolve);
      })
  );
  return { source, resolvers };
}

describe('DataList initial load across a mid-flight query change', () => {
  it('refetches and commits after the reload key changes while a request is pending', async () => {
    const { source, resolvers } = makeDeferredSource();
    const onTotalChange = vi.fn();

    const { rerender } = render(
      <DataList<Row>
        dataSource={source as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
        reloadKey={0}
      />
    );

    // First page request is issued and still pending.
    await waitFor(() => expect(source).toHaveBeenCalledTimes(1));

    // Query signature moves while that request is in flight.
    rerender(
      <DataList<Row>
        dataSource={source as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
        reloadKey={1}
      />
    );

    // The pending response now belongs to a superseded signature: it must be
    // discarded *and* replaced by a fresh request rather than silently dropped.
    resolvers[0]({ items: [{ id: 'stale', name: 'Stale' }], total: 1 });

    await waitFor(() => expect(source.mock.calls.length).toBeGreaterThanOrEqual(2));

    resolvers[resolvers.length - 1]({ items: [{ id: 'fresh', name: 'Fresh' }], total: 1 });

    // A committed (non-discarded) result reports its total and paints a row;
    // with the bug neither happened and the grid stayed on "Loading row".
    await waitFor(() => expect(onTotalChange).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Fresh')).toBeTruthy();
    expect(document.querySelector('[aria-label="Loading row"]')).toBeNull();
  });

  it('refetches when the dataSource identity changes while a request is pending', async () => {
    const first = makeDeferredSource();
    const second = makeDeferredSource();
    const onTotalChange = vi.fn();

    const { rerender } = render(
      <DataList<Row>
        dataSource={first.source as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
      />
    );

    await waitFor(() => expect(first.source).toHaveBeenCalledTimes(1));

    // The workspace hands DataList a new closure on every render.
    rerender(
      <DataList<Row>
        dataSource={second.source as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
      />
    );

    first.resolvers[0]({ items: [{ id: 'stale', name: 'Stale' }], total: 1 });

    await waitFor(() => expect(second.source).toHaveBeenCalled());
    second.resolvers[0]({ items: [{ id: 'fresh', name: 'Fresh' }], total: 2 });

    await waitFor(() => expect(onTotalChange).toHaveBeenCalledWith(2));
  });

  it('re-announces the total when a replacement dataSource returns the same number', async () => {
    const first = vi.fn(async () => ({ items: [{ id: 'first', name: 'First' }], total: 1 }));
    const second = vi.fn(async () => ({ items: [{ id: 'second', name: 'Second' }], total: 1 }));
    const onTotalChange = vi.fn();

    const { rerender } = render(
      <DataList<Row>
        dataSource={first as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
      />
    );

    await waitFor(() => expect(onTotalChange).toHaveBeenCalledTimes(1));
    rerender(
      <DataList<Row>
        dataSource={second as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
      />
    );

    await waitFor(() => expect(second).toHaveBeenCalled());
    await waitFor(() => expect(onTotalChange).toHaveBeenCalledTimes(2));
    expect(onTotalChange.mock.calls).toEqual([[1], [1]]);
  });

  it('refetches when the global filter changes while a request is pending', async () => {
    const { source, resolvers } = makeDeferredSource();
    const onTotalChange = vi.fn();

    const { rerender } = render(
      <DataList<Row>
        dataSource={source as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
        globalFilter={{ status: 'all' }}
      />
    );

    await waitFor(() => expect(source).toHaveBeenCalledTimes(1));

    rerender(
      <DataList<Row>
        dataSource={source as any}
        columns={columns as any}
        getItemId={getItemId}
        onTotalChange={onTotalChange}
        globalFilter={{ status: 'accepted' }}
      />
    );

    resolvers[0]({ items: [{ id: 'stale', name: 'Stale' }], total: 9 });

    await waitFor(() => expect(source.mock.calls.length).toBeGreaterThanOrEqual(2));
    resolvers[resolvers.length - 1]({ items: [{ id: 'fresh', name: 'Fresh' }], total: 3 });

    await waitFor(() => expect(onTotalChange).toHaveBeenCalledWith(3));
  });
});

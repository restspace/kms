/**
 * Regression (D1b): a data source that keeps failing must stop after a bounded
 * number of attempts and show the error banner with its Retry button.
 *
 * The browser smoke pass found the workspace firing thousands of requests a
 * second until Chrome answered `net::ERR_INSUFFICIENT_RESOURCES` — the grid was
 * being re-armed faster than the failures could settle, so `loadError` never
 * survived long enough to be shown. The circuit breaker in `loadMoreItems`
 * caps the attempts regardless of what keeps moving the query signature.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

// See DataList.reload.test.tsx: react-window ships CJS bound to the real React,
// whose frozen elements preact cannot diff. Both libraries are pure
// presentation here, so stub them with the smallest equivalents.
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

describe('DataList repeated fetch failures', () => {
  it('stops after a bounded number of attempts and offers Retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const source = vi.fn(() => Promise.reject(new Error('Failed to fetch')));

    const { rerender } = render(
      <DataList<Row>
        dataSource={source as any}
        columns={columns as any}
        getItemId={getItemId}
        reloadKey={0}
      />
    );

    await screen.findByText(/Failed to load items/);

    // Keep moving the query signature the way the oscillating workspace did:
    // each change resets the list and re-arms the initial load.
    for (let i = 1; i <= 12; i += 1) {
      rerender(
        <DataList<Row>
          dataSource={source as any}
          columns={columns as any}
          getItemId={getItemId}
          reloadKey={i}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy());

    const attemptsAfterStorm = source.mock.calls.length;
    // Bounded, not "one per signature change" and certainly not unbounded.
    expect(attemptsAfterStorm).toBeLessThanOrEqual(10);

    // And it stays stopped: no background retry keeps the source busy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(source.mock.calls.length).toBe(attemptsAfterStorm);

    consoleError.mockRestore();
  });

  it('recovers when the user clicks Retry and the source starts working', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let healthy = false;
    const source = vi.fn(() =>
      healthy
        ? Promise.resolve({ items: [{ id: 'a', name: 'Alice' }], total: 1 })
        : Promise.reject(new Error('Failed to fetch'))
    );

    render(
      <DataList<Row> dataSource={source as any} columns={columns as any} getItemId={getItemId} />
    );

    const retry = await screen.findByText('Retry');
    healthy = true;
    (retry as HTMLButtonElement).click();

    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(screen.queryByText(/Failed to load items/)).toBeNull();

    consoleError.mockRestore();
  });
});

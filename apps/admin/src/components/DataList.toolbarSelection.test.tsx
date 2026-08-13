/**
 * Eval defect #15: the org contact directory had no checkbox multi-select at
 * all, so "check 2+ contacts, then email them" had no grid-side path to
 * begin with. `onChecklist` renders the checkbox column (already used by the
 * Submissions tab's "↓ FILES" button); this pins that a toolbarAction sees
 * the live checked ids, and that a function `label` (added alongside
 * App.tsx's "MESSAGE SELECTED (N)" action) recomputes with them.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

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

import { DataList, type DataListToolbarAction } from './DataList';

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

const source = () =>
  Promise.resolve({
    items: [
      { id: 'a', name: 'Ada' },
      { id: 'b', name: 'Bea' },
    ],
    total: 2,
  });

describe('DataList checklist column + toolbarActions', () => {
  it('renders no checkbox column when onChecklist is absent', async () => {
    render(<DataList<Row> dataSource={source} columns={columns as any} getItemId={getItemId} />);
    await screen.findByText('Ada');
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
  });

  it('checking rows updates the toolbarAction\'s checkedIds and a function label recomputes', async () => {
    const onClick = vi.fn();
    const action: DataListToolbarAction = {
      id: 'message-selected',
      label: ({ checkedIds }) => (checkedIds.length > 0 ? `MESSAGE SELECTED (${checkedIds.length})` : 'MESSAGE SELECTED'),
      disabled: ({ checkedIds }) => checkedIds.length === 0 && 'Check one or more rows first',
      onClick,
    };

    render(
      <DataList<Row>
        dataSource={source}
        columns={columns as any}
        getItemId={getItemId}
        onChecklist={() => {}}
        toolbarActions={[action]}
      />,
    );
    await screen.findByText('Ada');

    // Disabled, unlabelled-count state before anything is checked.
    const button = screen.getByRole('button', { name: 'MESSAGE SELECTED' });
    expect(button.hasAttribute('disabled')).toBe(true);

    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);

    // The label recomputes from the live checked set, and the action is enabled.
    const updated = await screen.findByRole('button', { name: 'MESSAGE SELECTED (1)' });
    expect(updated.hasAttribute('disabled')).toBe(false);

    fireEvent.click(updated);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toMatchObject({ checkedIds: ['a'] });

    fireEvent.click(checkboxes[1]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'MESSAGE SELECTED (2)' })).toBeTruthy());
  });
});

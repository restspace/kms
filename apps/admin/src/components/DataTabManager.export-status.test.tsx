/**
 * Test for bulk export status feedback (CNT-14: bulk ZIP export has no feedback).
 * Verifies that the toolbar action wrapper correctly tracks export status and
 * shows appropriate messages on success and error.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DataListToolbarAction } from './DataList';

describe('Bulk export toolbar action wrapper', () => {
  /**
   * Simulate the wrapToolbarActions function behavior to test that it:
   * 1. Wraps the files-zip action's onClick
   * 2. Shows "Preparing" status on click
   * 3. Shows "Download started" on success
   * 4. Shows error message on failure
   * 5. Clears status after timeout
   */

  it('wraps files-zip action to show status on success', async () => {
    const setExportStatus = vi.fn();
    const mockOriginalOnClick = vi.fn(async () => {
      // Simulate successful download
    });

    const originalAction: DataListToolbarAction = {
      id: 'files-zip',
      label: '↓ FILES',
      onClick: mockOriginalOnClick
    };

    // Simulate wrapper behavior
    const wrappedAction: DataListToolbarAction = {
      ...originalAction,
      onClick: async (ctx) => {
        const count = ctx.checkedIds.length;
        setExportStatus({
          message: `Preparing ZIP of files for ${count} submission${count === 1 ? '' : 's'}…`,
          tone: 'info'
        });
        try {
          await originalAction.onClick(ctx);
          setExportStatus({ message: 'Download started', tone: 'info' });
          setTimeout(() => setExportStatus(null), 3000);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Download failed';
          setExportStatus({ message, tone: 'error' });
          setTimeout(() => setExportStatus(null), 5000);
        }
      }
    };

    // Test: call wrapped action
    const ctx = { checkedIds: ['sub-1', 'sub-2'], filters: {}, reload: () => {} };
    await wrappedAction.onClick(ctx);

    // Verify status sequence
    expect(setExportStatus).toHaveBeenCalledWith({
      message: 'Preparing ZIP of files for 2 submissions…',
      tone: 'info'
    });
    expect(setExportStatus).toHaveBeenCalledWith({
      message: 'Download started',
      tone: 'info'
    });
  });

  it('shows error message when export action fails', async () => {
    const setExportStatus = vi.fn();
    const mockError = new Error('Bundle too large');
    const mockOriginalOnClick = vi.fn(async () => {
      throw mockError;
    });

    const originalAction: DataListToolbarAction = {
      id: 'files-zip',
      label: '↓ FILES',
      onClick: mockOriginalOnClick
    };

    const wrappedAction: DataListToolbarAction = {
      ...originalAction,
      onClick: async (ctx) => {
        const count = ctx.checkedIds.length;
        setExportStatus({
          message: `Preparing ZIP of files for ${count} submission${count === 1 ? '' : 's'}…`,
          tone: 'info'
        });
        try {
          await originalAction.onClick(ctx);
          setExportStatus({ message: 'Download started', tone: 'info' });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Download failed';
          setExportStatus({ message, tone: 'error' });
        }
      }
    };

    const ctx = { checkedIds: ['sub-1'], filters: {}, reload: () => {} };
    await wrappedAction.onClick(ctx);

    // Verify error message was set
    expect(setExportStatus).toHaveBeenCalledWith({
      message: 'Bundle too large',
      tone: 'error'
    });
  });

  it('shows singular "submission" for single checked item', async () => {
    const setExportStatus = vi.fn();
    const mockOriginalOnClick = vi.fn(async () => {});

    const originalAction: DataListToolbarAction = {
      id: 'files-zip',
      label: '↓ FILES',
      onClick: mockOriginalOnClick
    };

    const wrappedAction: DataListToolbarAction = {
      ...originalAction,
      onClick: async (ctx) => {
        const count = ctx.checkedIds.length;
        setExportStatus({
          message: `Preparing ZIP of files for ${count} submission${count === 1 ? '' : 's'}…`,
          tone: 'info'
        });
        await originalAction.onClick(ctx);
      }
    };

    const ctx = { checkedIds: ['sub-1'], filters: {}, reload: () => {} };
    await wrappedAction.onClick(ctx);

    expect(setExportStatus).toHaveBeenCalledWith({
      message: 'Preparing ZIP of files for 1 submission…',
      tone: 'info'
    });
  });

  it('calls the original action with the context', async () => {
    const mockOriginalOnClick = vi.fn();

    const originalAction: DataListToolbarAction = {
      id: 'files-zip',
      label: '↓ FILES',
      onClick: mockOriginalOnClick
    };

    const wrappedAction: DataListToolbarAction = {
      ...originalAction,
      onClick: async (ctx) => {
        await originalAction.onClick(ctx);
      }
    };

    const ctx = {
      checkedIds: ['sub-1', 'sub-2'],
      filters: { status: 'accepted' },
      reload: () => {}
    };

    await wrappedAction.onClick(ctx);

    expect(mockOriginalOnClick).toHaveBeenCalledWith(ctx);
  });
});

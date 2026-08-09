import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// @ts-expect-error dynamically imported library
import { FixedSizeList as List, ListChildComponentProps, ListOnItemsRenderedProps, ListOnScrollProps } from 'react-window';
// @ts-expect-error dynamically imported library
import InfiniteLoader from 'react-window-infinite-loader';
import useElementSize from '../hooks/useElementSize';
import PlusIcon from '../assets/plus-icon.svg';
import { stableSerialize } from '../utils/stableSerialize';
import {
  applyCellEdit,
  applyCellMerge,
  applyCellRollback,
  beginPendingEdit,
  canEditCell,
  cellKey,
  clearCellStatus,
  rejectEdit,
  resolveEdit,
  type CellEditMap,
  type CellEditStatus,
} from './cellEditMachine';
import './DataList.css';

/**
 * react-window outer element that provides listbox semantics for accessibility tooling.
 * Built per-instance (via `createDataListOuterElement`) so the aria-label can reflect
 * the list's own `ariaLabel`/`tabName` prop rather than a hardcoded string.
 */
const createDataListOuterElement = (ariaLabel: string) =>
  React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function DataListOuterElement(props, ref) {
      return (
        <div
          ref={ref}
          role="listbox"
          aria-label={ariaLabel}
          aria-multiselectable="true"
          {...props}
        />
      );
    }
  );

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Human-readable rendering of a raw field value for row aria-labels: floats are
 * rounded to 2dp and ISO timestamps formatted like the visible date cells, so
 * screen readers never announce raw values like 333.59999999999997 or
 * 2026-01-27T13:30:16.420Z.
 */
const formatAriaValue = (raw: unknown): string => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(Math.round(raw * 100) / 100) : '';
  }
  if (typeof raw !== 'string') {
    return '';
  }
  const text = raw.trim();
  if (ISO_TIMESTAMP_PATTERN.test(text)) {
    const date = new Date(text);
    if (Number.isFinite(date.getTime())) {
      const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
      const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `${dateStr} ${timeStr}`;
    }
  }
  return text;
};

/**
 * Build a stable default row label from visible column values.
 */
const getDefaultItemAriaLabel = <T,>(
  item: T,
  index: number,
  columns: Array<ColumnDefinition<T>>
): string => {
  const parts: string[] = [];

  for (const column of columns) {
    const raw = item[column.field as keyof T];
    const text = formatAriaValue(raw);

    if (!text || parts.includes(text)) {
      continue;
    }

    parts.push(text);
    if (parts.length >= 3) {
      break;
    }
  }

  return parts.length > 0 ? parts.join(' - ') : `Row ${index + 1}`;
};

/**
 * Editable cell rendering context for DataList.
 */
export interface DataListEditRendererParams<T = any> {
  value: any;
  item: T;
  index: number;
  field: string;
  onChange: (nextValue: unknown) => void;
  /**
   * True while a previous write to this cell is still in flight. Renderers
   * should disable their control so the user can't stack a second edit on
   * top of an unresolved one.
   */
  disabled?: boolean;
  /**
   * Set when the previous write to this cell failed and the value was rolled
   * back. Cleared automatically on the next interaction with the cell.
   */
  status?: CellEditStatus;
}

/**
 * Cell change payload for editable DataList columns.
 */
export interface DataListCellChange<T = any> {
  field: string;
  value: unknown;
  item: T;
  previousItem: T;
  index: number;
}

/**
 * A cell change handler may resolve synchronously (returning a full
 * replacement row, a partial patch, or nothing) or asynchronously — return a
 * Promise to let DataList mark the cell pending, disable its editor, and roll
 * the value back if the write fails. A resolved Promise's value (if any) is
 * merged onto the row — server-returned fields win over the optimistic local
 * edit.
 */
// `Record<string, unknown>` (in addition to `T`/`Partial<T>`) covers handlers
// like `updateSubmissionStatus` that resolve to an unrelated ack shape (e.g.
// `{ ok: boolean }`) rather than row fields — DataList merges whatever comes
// back, so any plain object resolves cleanly. Without it, TypeScript's
// "weak type" rule would reject a resolved value with zero properties in
// common with `Partial<T>` (every member of which is optional).
export type DataListCellChangeResult<T = any> = T | Partial<T> | Record<string, unknown> | void;
export type DataListCellChangeHandler<T = any> = (
  change: DataListCellChange<T>
) => DataListCellChangeResult<T> | Promise<DataListCellChangeResult<T>>;

/**
 * Column definition for DataList
 */
export interface ColumnDefinition<T = any> {
  field: keyof T | string;
  header: string;
  width?: string; // CSS grid size (e.g., "1fr", "200px")
  sortable?: boolean;
  render?: (value: any, item: T) => React.ReactNode;
  /**
   * When provided, the column is placed in the given mobile card row.
   * Row 1 = primary identity fields; row 2 = secondary/detail fields.
   * Columns without this property appear in row 1.
   */
  mobileRow?: 1 | 2;
  /**
   * Override for the column header label shown in mobile card rows.
   * Set to '' to suppress the label. Falls back to `header` when omitted.
   */
  mobileHeader?: string;
  /**
   * Mobile-only render function. When provided, replaces `render` inside mobile card cells.
   */
  mobileRender?: (value: any, item: T) => React.ReactNode;
  /**
   * When true, the column is not shown in mobile card layout.
   */
  mobileHidden?: boolean;
  /**
   * Optional inline style applied to the mobile card cell container div.
   */
  mobileCellStyle?: React.CSSProperties;
  /**
   * When true, this column renders an editable control for the row.
   * Use a function to enable editing only for specific rows.
   */
  editable?: boolean | ((item: T) => boolean);
  /**
   * Optional inline style applied to the cell container div in desktop (grid) rows.
   */
  cellStyle?: React.CSSProperties;
  /**
   * Custom renderer for editable cells. Receives an onChange helper wired to row updates.
   */
  editRenderer?: (params: DataListEditRendererParams<T>) => React.ReactNode;
  /**
   * Optional per-cell change handler. Return a full row to apply additional field updates.
   */
  onChange?: DataListCellChangeHandler<T>;
}

export type SortDirection = 'asc' | 'desc' | null;

export interface SortState {
  field: string | null;
  direction: SortDirection;
}

export interface DataSourceParams {
  from: number;
  size: number;
  filters: Record<string, any>;
  sort?: { field: string; direction: 'asc' | 'desc' };
}

export interface DataSourceResult<T = any> {
  items: T[];
  total: number;
}

/**
 * Props passed to DataList filter components.
 */
export interface DataListFilterProps<TFilters extends Record<string, any> = Record<string, any>> {
  filters: TFilters;
  setFilters: React.Dispatch<React.SetStateAction<TFilters>>;
  resetFilters: () => void;
}

/**
 * Configuration for optional DataList filter UI and state.
 */
export interface DataListFilterConfig<TFilters extends Record<string, any> = Record<string, any>> {
  initialFilters: TFilters;
  /**
   * Canonical empty filter values used by `resetFilters` (the Clear Filters action).
   * Required whenever `initialFilters` is a seed that tracks the user's current
   * filters across tab remounts — resetting to such a seed is a no-op.
   * Falls back to `initialFilters` when omitted.
   */
  defaultFilters?: TFilters;
  FilterComponent: React.ComponentType<DataListFilterProps<TFilters>>;
  /**
   * Additional props to pass to the FilterComponent.
   * Useful for passing functions like fetchRelatedRecords or other context.
   */
  filterProps?: Record<string, any>;
}

export interface DataListQuery {
  filters: Record<string, any>;
  sort?: { field: string; direction: 'asc' | 'desc' };
  /** The tab-local filter values only, without the global filter merged in. */
  localFilters?: Record<string, any>;
}

/**
 * Working state captured from a previous mount of the same logical list,
 * used to restore the user's sort/filters/checklist when a list tab is
 * remounted (list tabs unmount while inactive). Read once at mount.
 */
export interface DataListRestoredState<TFilters extends Record<string, any> = Record<string, any>> {
  /** Restored sort; `null` means the user had explicitly cleared the sort. */
  sort?: { field: string; direction: 'asc' | 'desc' } | null;
  localFilters?: TFilters;
  checkedIds?: string[];
}

export type DataListSummaryData = Partial<Record<string, string>>;

export type DataListSummaryDataSource = (
  filters: Record<string, any>
) => DataListSummaryData | Promise<DataListSummaryData | null | undefined> | null | undefined;

/**
 * Optional export buttons (CSV/XLSX) floating at the bottom-left of the list.
 * The consumer builds the URL from the list's live merged filters + sort, so
 * exports always match exactly what the grid is showing.
 */
export interface DataListExportConfig {
  buildUrl: (
    format: 'csv' | 'xlsx',
    query: { filters: Record<string, any>; sort?: { field: string; direction: 'asc' | 'desc' } }
  ) => string;
  /**
   * Optional title attribute for the export buttons, overriding the default
   * "Export the current view as CSV/XLSX" tooltip. Useful for a caveat such
   * as "cross-event export not yet available — exports the current event only".
   */
  title?: string;
}

export interface DataListRowDragPayload {
  sourceType: string;
  id: string;
  label?: string;
  data?: Record<string, unknown>;
  mimeData?: Record<string, string>;
}

export interface DataListRowDragConfig<T = any> {
  isRowDraggable?: (item: T) => boolean;
  getDragPayload: (item: T) => DataListRowDragPayload;
  getPlainText?: (item: T) => string;
}

export interface DataListRowDropConfig<T = any> {
  canDrop?: (targetItem: T, payload: DataListRowDragPayload) => boolean;
  onDrop: (targetItem: T, payload: DataListRowDragPayload) => void | Promise<void>;
}

/**
 * Configuration for inline "fast add" row creation. A draft row is pinned
 * above the virtualized list; Enter commits it, Escape discards it. Columns
 * decide whether they are editable for the draft via their normal `editable`
 * check (drafts carry the seed from `createDraft`, typically a `__draft` flag).
 */
export interface DataListFastAddConfig<T = any> {
  /**
   * Seed the draft row (generated id, defaults, `__draft: true` sentinel).
   * Receives the list's current merged filters (local + global).
   */
  createDraft: (filters: Record<string, any>) => Partial<T>;
  /**
   * Seed a draft anchored to an existing row (e.g. quick-add a child into a
   * group header). Return null when the row cannot anchor a draft. Opened via
   * the `fastAddRequest` prop (typically from a row context-menu option).
   */
  createDraftForItem?: (item: T, filters: Record<string, any>) => Partial<T> | null;
  /** Fields that must be non-empty before the draft can be committed. */
  requiredFields: Array<{ field: string; label: string }>;
  /** Persist the draft. Return true on success; DataList clears and refetches. */
  onCommit: (draft: Partial<T>) => Promise<boolean>;
  /** Gate the quick-add button (e.g. requires a selected project filter). */
  isEnabled?: (filters: Record<string, any>) => boolean | { enabled: boolean; message?: string };
  /**
   * After a successful commit, immediately open a fresh draft with the same
   * seed source (same anchor row for anchored drafts) for successive entry.
   */
  rearmAfterCommit?: boolean;
}

export interface DataListProps<T = any, TFilters extends Record<string, any> = Record<string, any>> {
  dataSource: (params: DataSourceParams) => Promise<DataSourceResult<T>>;
  columns: ColumnDefinition<T>[];
  getItemId: (item: T) => string;
  onItemClick?: (item: T, index: number) => void;
  onItemDoubleClick?: (item: T, index: number, event: React.MouseEvent) => void;
  onItemContextMenu?: (item: T, index: number, event: React.MouseEvent) => void;
  /**
   * Callback fired when a row is shift+clicked. Receives the event so the consumer
   * can check ctrlKey/metaKey for additive behaviour.
   */
  onShiftClick?: (item: T, index: number, event: React.MouseEvent) => void;
  onSelectionChange?: (item: T | null) => void;
  getItemAriaLabel?: (item: T, index: number) => string;
  /**
   * When true, selecting an already-selected row still notifies onSelectionChange.
   * Useful for side-effect tabs that should react to re-clicking the same item.
   */
  notifyOnReselect?: boolean;
  /**
   * Optional initial sort configuration. When provided, the list will start with this sort applied.
   */
  initialSort?: { field: string; direction: 'asc' | 'desc' };
  /**
   * When provided, the list syncs its selection to the external value.
   * Pass null to clear the selection.
   */
  selectedItem?: T | null;
  /**
   * Optional selection id override when the selected item object is not available.
   */
  selectedItemId?: string | null;
  onTotalChange?: (total: number) => void;
  globalFilter?: Record<string, any>;
  filterConfig?: DataListFilterConfig<TFilters>;
  /**
   * Optional callback fired when the merged query (filters + sort) changes.
   */
  onQueryChange?: (query: DataListQuery) => void;
  /**
   * Optional summary data source for a sticky bottom row keyed by column field.
   */
  getSummaryData?: DataListSummaryDataSource;
  /**
   * When true, the list will auto-select the sole row when the filtered result set
   * contains exactly one item. Multi-item lists never default a selection.
   * Pass 'always' to auto-select the first row of any non-empty result set.
   */
  autoSelectFirstRow?: boolean | 'always';
  /**
   * Optional handler for the floating "add" button.
   * When provided, a "+" button appears at the bottom-right of the list.
   */
  onAddClick?: () => void;
  /**
   * Optional inline "fast add" configuration. When provided, a lightning
   * quick-add button opens a pinned draft row above the list (desktop only).
   */
  fastAdd?: DataListFastAddConfig<T>;
  /**
   * Request to open a fast-add draft anchored to a row (see
   * `DataListFastAddConfig.createDraftForItem`). A new `token` value opens
   * (or re-seeds) the draft for `item`.
   */
  fastAddRequest?: { item: T; token: number } | null;
  /**
   * Optional handler for checklist selections.
   * When provided, a checkbox column is rendered as the first field.
   */
  onChecklist?: (checkedIds: string[]) => void;
  /**
   * Optional helper to include checks from other tabs when reporting selections.
   * Requires tabName when provided.
   */
  getOtherChecks?: (tabName: string) => string[];
  /**
   * Optional checklist marker colour. When provided, checklist rows render a
   * coloured status circle around the checkbox.
   */
  getChecklistMarkerColor?: (item: T) => string | undefined;
  /**
   * Optional machine-readable status for the checklist marker, surfaced as
   * `data-status`/`data-overdue`/`aria-label` on the marker so automated tests
   * can assert status without parsing the marker colour. Parallel to
   * getChecklistMarkerColor.
   */
  getChecklistMarkerStatus?: (item: T) => { status?: string; overdue?: boolean } | undefined;
  /**
   * Tab name passed to getOtherChecks to identify the current list.
   */
  tabName?: string;
  checklistResetKey?: number | string;
  /**
   * Working state from a previous mount of this list (sort/filters/checklist),
   * applied once at mount so tab switches don't lose the user's place.
   */
  restoredState?: DataListRestoredState<TFilters>;
  /**
   * Reports the list's own checked ids (excluding other tabs' checks) whenever
   * they change, so the parent can restore them across remounts.
   */
  onLocalChecksChange?: (checkedIds: string[]) => void;
  /** When provided, CSV/XLSX export buttons render at the bottom-left. */
  exportConfig?: DataListExportConfig;
  rowHeight?: number;
  /**
   * Width breakpoint (px) below which the list switches to mobile card layout.
   * Defaults to 640.
   */
  mobileBreakpointWidth?: number;
  /**
   * Row height (px) to use in mobile card layout when columns are split across two sub-rows.
   * Defaults to 88.
   */
  mobileRowHeight?: number;
  batchSize?: number;
  className?: string;
  reloadKey?: number | string;
  rowDrag?: DataListRowDragConfig<T>;
  rowDrop?: DataListRowDropConfig<T>;
  /**
   * Optional per-row edit-access check. When it denies a row (`false` or
   * `{ allowed: false }`), the row renders with a locked/disabled visual treatment
   * (dimmed + lock indicator + tooltip message) as an upfront cue — this does not
   * block clicks itself, callers still enforce the actual restriction on interaction.
   */
  getEditAccess?: (item: T) => boolean | { allowed: boolean; message?: string };
  /**
   * Accessible label for the scrollable listbox region. Falls back to
   * `tabName` (the tab's own title) when omitted, then to "Records".
   */
  ariaLabel?: string;
}

// KMS skin pass: compact 32px rows per docs/11 §4 (atelyr default was 52).
const DEFAULT_ROW_HEIGHT = 32;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MOBILE_BREAKPOINT_WIDTH = 640;
const CHECKBOX_COLUMN_WIDTH = '36px';
const ROW_DRAG_SUPPRESSED_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number'
]);

/**
 * Returns whether a drag started in an editable text control where users expect
 * pointer movement to select text rather than move the row.
 */
const isTextEditDragTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const textEditElement = target.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
  if (!(textEditElement instanceof HTMLElement)) {
    return false;
  }

  if (textEditElement instanceof HTMLTextAreaElement) {
    return true;
  }

  if (textEditElement instanceof HTMLInputElement) {
    return ROW_DRAG_SUPPRESSED_INPUT_TYPES.has(textEditElement.type);
  }

  return true;
};

/**
 * Temporarily removes row draggability before the browser creates a drag image
 * from text selection gestures inside editable controls.
 */
const disableRowDragDuringTextEditGesture = (
  rowElement: HTMLDivElement,
  shouldRestoreDraggable: boolean
): void => {
  if (!shouldRestoreDraggable || !rowElement.draggable || typeof window === 'undefined') {
    return;
  }

  rowElement.draggable = false;

  const restoreRowDrag = () => {
    rowElement.draggable = shouldRestoreDraggable;
    window.removeEventListener('pointerup', restoreRowDrag);
    window.removeEventListener('pointercancel', restoreRowDrag);
    window.removeEventListener('mouseup', restoreRowDrag);
  };

  window.addEventListener('pointerup', restoreRowDrag, { once: true });
  window.addEventListener('pointercancel', restoreRowDrag, { once: true });
  window.addEventListener('mouseup', restoreRowDrag, { once: true });
};

/**
 * Returns whether the current viewport should use the mobile list layout.
 */
const isViewportMobile = (breakpointWidth: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.innerWidth < breakpointWidth;
};

interface DataListRowData<T> {
  items: T[];
  columns: ColumnDefinition<T>[];
  selectedIndex: number | null;
  gridTemplateColumns: string;
  isMobile: boolean;
  hasMobileRow2: boolean;
  rowDrag?: DataListRowDragConfig<T>;
  rowDrop?: DataListRowDropConfig<T>;
  dropTargetItemId: string | null;
  cellEditMap: CellEditMap;
  onChecklist?: (checkedIds: string[]) => void;
  checkedItemIds: Set<string>;
  getChecklistMarkerColor?: (item: T) => string | undefined;
  getChecklistMarkerStatus?: (item: T) => { status?: string; overdue?: boolean } | undefined;
  getItemId: (item: T) => string;
  handleChecklistToggle: (itemId: string, shouldCheck: boolean) => void;
  handleRowDragStart: (item: T, event: React.DragEvent<HTMLDivElement>) => void;
  handleRowDragEnd: () => void;
  handleRowDragOver: (item: T, event: React.DragEvent<HTMLDivElement>) => void;
  handleRowDragLeave: (item: T, event: React.DragEvent<HTMLDivElement>) => void;
  handleRowDrop: (item: T, event: React.DragEvent<HTMLDivElement>) => void;
  handleItemClick: (item: T, index: number, event: React.MouseEvent) => void;
  handleItemNativeDoubleClick: (item: T, index: number, event: React.MouseEvent) => void;
  handleItemContextMenu: (item: T, index: number, event: React.MouseEvent) => void;
  getItemAriaLabel: (item: T, index: number) => string;
  handleCellChange: (index: number, column: ColumnDefinition<T>, nextValue: unknown) => void;
  getEditAccess?: (item: T) => boolean | { allowed: boolean; message?: string };
}

/**
 * Generic windowed list component with infinite scrolling, sorting, and filtering.
 * Based on react-window and react-window-infinite-loader.
 */
export const DataList = <T extends Record<string, any>, TFilters extends Record<string, any> = Record<string, any>>({
  dataSource,
  columns,
  getItemId,
  onItemClick,
  onItemDoubleClick,
  onItemContextMenu,
  onShiftClick,
  onSelectionChange,
  getItemAriaLabel: getItemAriaLabelProp,
  notifyOnReselect = false,
  selectedItem,
  selectedItemId: selectedItemIdOverride,
  onTotalChange,
  globalFilter,
  filterConfig,
  onQueryChange,
  getSummaryData,
  initialSort,
  autoSelectFirstRow = true,
  onAddClick,
  onChecklist,
  getOtherChecks,
  getChecklistMarkerColor,
  getChecklistMarkerStatus,
  tabName,
  checklistResetKey,
  restoredState,
  onLocalChecksChange,
  exportConfig,
  rowHeight = DEFAULT_ROW_HEIGHT,
  mobileBreakpointWidth,
  mobileRowHeight,
  batchSize = DEFAULT_BATCH_SIZE,
  className = '',
  reloadKey,
  rowDrag,
  rowDrop,
  getEditAccess,
  fastAdd,
  fastAddRequest,
  ariaLabel
}: DataListProps<T, TFilters>) => {
  const [items, setItems] = useState<T[]>([]);
  const [endReached, setEndReached] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sortState, setSortState] = useState<SortState>(() => {
    // restoredState.sort === null means the user had explicitly cleared the sort;
    // undefined means there is no restored state, so the configured default applies.
    if (restoredState && restoredState.sort !== undefined) {
      return restoredState.sort
        ? { field: restoredState.sort.field, direction: restoredState.sort.direction }
        : { field: null, direction: null };
    }
    return initialSort
      ? { field: initialSort.field, direction: initialSort.direction }
      : { field: null, direction: null };
  });
  const emptyFiltersRef = useRef({} as TFilters);
  const [localFilters, setLocalFilters] = useState<TFilters>(() => (
    restoredState?.localFilters
      ?? (filterConfig ? filterConfig.initialFilters : emptyFiltersRef.current)
  ));
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() => {
    if (selectedItemIdOverride !== undefined) {
      return selectedItemIdOverride;
    }
    if (selectedItem !== undefined) {
      return selectedItem ? getItemId(selectedItem) : null;
    }
    return null;
  });
  const [dataSourceVersion, setDataSourceVersion] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [summaryData, setSummaryData] = useState<DataListSummaryData | null>(null);
  const [checkedItemIds, setCheckedItemIds] = useState<Set<string>>(
    () => new Set(restoredState?.checkedIds ?? [])
  );
  const [dropTargetItemId, setDropTargetItemId] = useState<string | null>(null);
  const [draftItem, setDraftItem] = useState<T | null>(null);
  const [draftErrors, setDraftErrors] = useState<Set<string>>(() => new Set());
  const [isCommittingDraft, setIsCommittingDraft] = useState(false);
  // Bumped after a successful fast-add commit to refetch through querySignature.
  const [fastAddReloadCounter, setFastAddReloadCounter] = useState(0);
  const draftRowRef = useRef<HTMLDivElement | null>(null);
  // Anchor row for item-anchored drafts; re-arm reseeds from the same anchor.
  const draftAnchorRef = useRef<T | null>(null);
  // Bumped whenever a draft (re)opens so the first editable control refocuses.
  const [draftGeneration, setDraftGeneration] = useState(0);
  // Per-cell (rowId:field) pending/error status for failure-aware inline edits.
  const [cellEditMap, setCellEditMap] = useState<CellEditMap>(() => new Map());
  // Visually-hidden aria-live announcement for a rolled-back edit.
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  // Deduplicate in-flight requests
  const inFlight = useRef<Set<string>>(new Set());
  const dataSourceRef = useRef(dataSource);
  const selectionChangeRef = useRef(onSelectionChange);
  const selectedItemRef = useRef<T | null>(selectedItem ?? null);
  const activeRowDragPayloadRef = useRef<DataListRowDragPayload | null>(null);
  // Mirrors `items`/`cellEditMap` synchronously so handleCellChange can gate
  // and read the latest values without waiting for a functional setState.
  const itemsRef = useRef<T[]>(items);
  itemsRef.current = items;
  const cellEditMapRef = useRef<CellEditMap>(cellEditMap);
  cellEditMapRef.current = cellEditMap;
  const [wrapperRef, size] = useElementSize<HTMLDivElement>();
  const mobileBreakpoint = mobileBreakpointWidth ?? DEFAULT_MOBILE_BREAKPOINT_WIDTH;
  const [isMobile, setIsMobile] = useState(() => isViewportMobile(mobileBreakpoint));
  const hasMobileRow2 = useMemo(() => columns.some(c => c.mobileRow === 2 && !c.mobileHidden), [columns]);
  const effectiveItemSize = isMobile && hasMobileRow2 ? (mobileRowHeight ?? 88) : isMobile ? 78 : rowHeight;
  const listRef = useRef<any>(null);
  const scrollOffsetRef = useRef(0);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const globalFilterSignature = useMemo(
    () => stableSerialize(globalFilter ?? {}),
    [globalFilter]
  );
  const localFilterSignature = useMemo(
    () => stableSerialize(localFilters ?? {}),
    [localFilters]
  );
  const resolvedInitialFilters = filterConfig ? filterConfig.initialFilters : emptyFiltersRef.current;
  const initialFilterSignature = useMemo(
    () => stableSerialize(resolvedInitialFilters),
    [resolvedInitialFilters]
  );
  const sortSignature = useMemo(
    () => stableSerialize(sortState),
    [sortState]
  );
  const querySignature = useMemo(
    () => `${globalFilterSignature}:${localFilterSignature}:${sortSignature}:${dataSourceVersion}:${stableSerialize(reloadKey ?? null)}:${fastAddReloadCounter}`,
    [globalFilterSignature, localFilterSignature, sortSignature, dataSourceVersion, reloadKey, fastAddReloadCounter]
  );
  const summarySignature = useMemo(
    () => `${globalFilterSignature}:${localFilterSignature}:${stableSerialize(reloadKey ?? null)}`,
    [globalFilterSignature, localFilterSignature, reloadKey]
  );
  const querySignatureRef = useRef(querySignature);
  const summarySignatureRef = useRef(summarySignature);
  const lastInitialFilterSignatureRef = useRef(initialFilterSignature);
  const lastInitialSortRef = useRef<string>(
    initialSort ? `${initialSort.field}:${initialSort.direction}` : ''
  );
  const externalSelectionId = useMemo(() => {
    if (selectedItemIdOverride !== undefined) {
      return selectedItemIdOverride;
    }
    if (selectedItem !== undefined) {
      return selectedItem ? getItemId(selectedItem) : null;
    }
    return undefined;
  }, [getItemId, selectedItem, selectedItemIdOverride]);

  useEffect(() => {
    setIsMobile(isViewportMobile(mobileBreakpoint));

    const handleResize = () => {
      setIsMobile(isViewportMobile(mobileBreakpoint));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [mobileBreakpoint]);

  useEffect(() => {
    if (dataSourceRef.current !== dataSource) {
      pendingScrollRestoreRef.current = scrollOffsetRef.current;
      dataSourceRef.current = dataSource;
      setDataSourceVersion((prev) => prev + 1);
    }
  }, [dataSource]);

  useEffect(() => {
    if (lastInitialFilterSignatureRef.current === initialFilterSignature) {
      return;
    }
    lastInitialFilterSignatureRef.current = initialFilterSignature;
    if (localFilterSignature === initialFilterSignature) {
      return;
    }
    setLocalFilters(resolvedInitialFilters);
  }, [initialFilterSignature, localFilterSignature, resolvedInitialFilters]);

  useEffect(() => {
    const nextSignature = initialSort ? `${initialSort.field}:${initialSort.direction}` : '';
    if (lastInitialSortRef.current === nextSignature) {
      return;
    }
    lastInitialSortRef.current = nextSignature;
    setSortState(
      initialSort
        ? { field: initialSort.field, direction: initialSort.direction }
        : { field: null, direction: null }
    );
  }, [initialSort?.direction, initialSort?.field]);

  const lastChecklistResetKeyRef = useRef(checklistResetKey);
  useEffect(() => {
    // Only clear when the reset key actually changes — running on mount would
    // wipe checks restored via restoredState every time the tab remounts.
    if (lastChecklistResetKeyRef.current === checklistResetKey) {
      return;
    }
    lastChecklistResetKeyRef.current = checklistResetKey;
    if (!onChecklist) {
      return;
    }
    setCheckedItemIds(new Set());
    onLocalChecksChange?.([]);
    const otherChecks = getOtherChecks && tabName ? getOtherChecks(tabName) : [];
    onChecklist(Array.from(new Set(otherChecks)));
  }, [checklistResetKey]);

  useEffect(() => {
    selectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    querySignatureRef.current = querySignature;
  }, [querySignature]);

  useEffect(() => {
    summarySignatureRef.current = summarySignature;
  }, [summarySignature]);

  useEffect(() => {
    if (externalSelectionId === undefined) {
      return;
    }
    if (externalSelectionId !== selectedItemId) {
      setSelectedItemId(externalSelectionId);
      if (!selectedItem) {
        selectedItemRef.current = null;
      }
    }
    if (externalSelectionId === null) {
      selectedItemRef.current = null;
      return;
    }
    if (selectedItem && getItemId(selectedItem) === externalSelectionId) {
      selectedItemRef.current = selectedItem;
    }
  }, [externalSelectionId, getItemId, selectedItem, selectedItemId]);

  const selectedIndex = useMemo(() => {
    if (selectedItemId === null) {
      return null;
    }
    const index = items.findIndex((item) => getItemId(item) === selectedItemId);
    return index >= 0 ? index : null;
  }, [getItemId, items, selectedItemId]);

  const isListComplete = totalCount !== null ? items.length >= totalCount : endReached;
  const hasSingleItem = totalCount === 1 || (endReached && items.length === 1);

  const selectItem = useCallback((item: T) => {
    const itemId = getItemId(item);
    if (selectedItemId === itemId) {
      selectedItemRef.current = item;
      if (notifyOnReselect && selectionChangeRef.current) {
        selectionChangeRef.current(item);
      }
      return;
    }
    selectedItemRef.current = item;
    setSelectedItemId(itemId);
    if (selectionChangeRef.current) {
      selectionChangeRef.current(item);
    }
  }, [getItemId, notifyOnReselect, selectedItemId]);

  const clearSelection = useCallback(() => {
    if (selectedItemId === null && selectedItemRef.current === null) {
      return;
    }
    selectedItemRef.current = null;
    setSelectedItemId(null);
    if (selectionChangeRef.current) {
      selectionChangeRef.current(null);
    }
  }, [selectedItemId]);

  const isItemLoaded = useCallback(
    (index: number) => index < items.length,
    [items.length]
  );

  /**
   * Build filters by merging local filters with global filter
   */
  const buildFilters = useCallback(() => {
    const filters: Record<string, any> = {};
    if (localFilters) {
      Object.assign(filters, localFilters);
    }
    if (globalFilter) {
      Object.assign(filters, globalFilter);
    }
    return filters;
  }, [globalFilter, localFilters]);

  const mergedFilters = useMemo(() => buildFilters(), [buildFilters, globalFilterSignature, localFilterSignature]);
  const queryForCallback = useMemo<DataListQuery>(() => {
    const sort = sortState.field && sortState.direction
      ? { field: sortState.field, direction: sortState.direction }
      : undefined;
    return { filters: mergedFilters, sort, localFilters: localFilters ?? {} };
  }, [localFilters, mergedFilters, sortState.field, sortState.direction]);
  const queryForCallbackSignature = useMemo(
    () => stableSerialize(queryForCallback),
    [queryForCallback]
  );
  const lastQuerySignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onQueryChange) {
      return;
    }
    if (lastQuerySignatureRef.current === queryForCallbackSignature) {
      return;
    }
    lastQuerySignatureRef.current = queryForCallbackSignature;
    onQueryChange(queryForCallback);
  }, [onQueryChange, queryForCallback, queryForCallbackSignature]);

  useEffect(() => {
    if (!getSummaryData) {
      setSummaryData(null);
      return;
    }

    const requestSignature = summarySignature;
    let isCurrent = true;

    const loadSummaryData = async () => {
      try {
        const result = await getSummaryData(mergedFilters);
        if (!isCurrent || summarySignatureRef.current !== requestSignature) {
          return;
        }
        const nextSummary = result && Object.keys(result).length > 0 ? result : null;
        setSummaryData(nextSummary);
      } catch (e) {
        if (!isCurrent || summarySignatureRef.current !== requestSignature) {
          return;
        }
        console.error('DataList getSummaryData error:', e);
        setSummaryData(null);
      }
    };

    void loadSummaryData();

    return () => {
      isCurrent = false;
    };
  }, [getSummaryData, mergedFilters, summarySignature]);

  const resetFilters = useCallback(() => {
    if (!filterConfig) {
      return;
    }
    setLocalFilters(filterConfig.defaultFilters ?? filterConfig.initialFilters);
  }, [filterConfig]);

  /**
   * Load more items from the data source
   */
  const loadMoreItems = useCallback(
    async (_startIndex: number, _stopIndex: number) => {
      if (endReached) return;

      const from = items.length;
      const size = batchSize;
      const filters = buildFilters();
      const sort = sortState.field && sortState.direction
        ? { field: sortState.field, direction: sortState.direction }
        : undefined;
      const requestSignature = querySignature;

      const key = `${from}:${size}:${stableSerialize(filters)}:${stableSerialize(sort ?? null)}`;

      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);

      try {
        const result = await dataSource({ from, size, filters, sort });
        if (querySignatureRef.current !== requestSignature) {
          return;
        }
        setItems((prev) => (from === 0 ? result.items : prev.concat(result.items)));

        if (result.total !== undefined && result.total !== null) {
          setTotalCount(result.total);
          if (onTotalChange) {
            onTotalChange(result.total);
          }
        }

        if (result.items.length < size) {
          setEndReached(true);
        }
      } catch (e) {
        console.error('DataList loadMoreItems error:', e);
        if (querySignatureRef.current === requestSignature) {
          setLoadError(e instanceof Error ? e.message : 'Unexpected error.');
          // Stop the infinite loader from hammering a failing source; the error
          // banner's Retry button re-opens loading. Must stay signature-guarded:
          // a stale request failing after a reload would otherwise mark the
          // fresh empty list as complete and wipe the selection.
          setEndReached(true);
        }
      } finally {
        inFlight.current.delete(key);
      }
    },
    [endReached, items.length, batchSize, buildFilters, sortState, dataSource, onTotalChange]
  );

  /**
   * Reset data when sort or filters change
   */
  useEffect(() => {
    setItems([]);
    setEndReached(false);
    setLoadError(null);
    setTotalCount(null);
    inFlight.current.clear();
  }, [querySignature]);

  const needsInitialLoadRef = useRef(true);

  useEffect(() => {
    needsInitialLoadRef.current = true;
  }, [querySignature]);

  /** Re-open loading after a fetch error; the effect below kicks off the fetch. */
  const handleRetryLoad = useCallback(() => {
    setLoadError(null);
    needsInitialLoadRef.current = true;
    setEndReached(false);
  }, []);

  useEffect(() => {
    if (!needsInitialLoadRef.current) {
      return;
    }
    if (endReached) {
      return;
    }
    if (items.length !== 0) {
      return;
    }

    // Kick off the first page load. In most cases `InfiniteLoader` triggers this automatically,
    // but we've seen cases where a filter toggle resets the list to "Loading…" without a fetch.
    // `inFlight` de-dupes concurrent calls, so this is safe even if `InfiniteLoader` also requests.
    needsInitialLoadRef.current = false;
    void loadMoreItems(0, Math.max(0, batchSize - 1));
  }, [batchSize, endReached, items.length, loadMoreItems]);

  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    const pendingOffset = pendingScrollRestoreRef.current;
    if (pendingOffset === null) {
      return;
    }
    listRef.current?.scrollTo?.(pendingOffset);
    pendingScrollRestoreRef.current = null;
  }, [items.length]);

  /**
   * Sync selected item when it reappears in the current data set.
   */
  useEffect(() => {
    if (selectedItemId === null || selectedIndex === null) {
      return;
    }
    const resolvedItem = items[selectedIndex];
    if (!resolvedItem) {
      return;
    }
    const resolvedId = getItemId(resolvedItem);
    const currentId = selectedItemRef.current ? getItemId(selectedItemRef.current) : null;
    if (currentId === resolvedId) {
      selectedItemRef.current = resolvedItem;
      return;
    }
    selectedItemRef.current = resolvedItem;
    if (selectionChangeRef.current) {
      selectionChangeRef.current(resolvedItem);
    }
  }, [getItemId, items, selectedIndex, selectedItemId]);

  /**
   * Reconcile selection after data changes.
   */
  const autoSelectSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    autoSelectSignatureRef.current = null;
  }, [querySignature]);

  useEffect(() => {
    // A failed load leaves the list empty/"complete" without reflecting real
    // data — never clear the user's selection (and any global filter sourced
    // from it) off the back of an error state.
    if (loadError) {
      return;
    }
    if (items.length === 0) {
      if (selectedItemId !== null && isListComplete) {
        clearSelection();
      }
      return;
    }

    const shouldAutoSelect = autoSelectFirstRow === 'always'
      ? items.length > 0
      : (autoSelectFirstRow && hasSingleItem);

    if (selectedItemId === null) {
      if (shouldAutoSelect) {
        if (autoSelectSignatureRef.current === querySignature) {
          return;
        }
        autoSelectSignatureRef.current = querySignature;
        selectItem(items[0]);
      }
      return;
    }

    if (selectedIndex !== null) {
      return;
    }

    if (shouldAutoSelect && (autoSelectFirstRow !== 'always' || isListComplete)) {
      selectItem(items[0]);
      return;
    }

    if (isListComplete) {
      clearSelection();
    }
  }, [
    autoSelectFirstRow,
    clearSelection,
    hasSingleItem,
    isListComplete,
    items,
    loadError,
    querySignature,
    selectedIndex,
    selectedItemId,
    selectItem
  ]);

  /**
   * Handle column header click for sorting
   */
  const handleHeaderClick = useCallback((column: ColumnDefinition<T>) => {
    if (!column.sortable) return;

    setSortState((prev) => {
      const field = String(column.field);
      if (prev.field !== field) {
        // New column: start with ascending
        return { field, direction: 'asc' };
      } else if (prev.direction === 'asc') {
        // Same column, was ascending: go to descending
        return { field, direction: 'desc' };
      } else {
        // Same column, was descending: clear sort
        return { field: null, direction: null };
      }
    });
  }, []);

  /**
   * Track the previous click to detect double-clicks manually. Detection is
   * manual (rather than the native dblclick event) because the selection
   * re-render can swallow the browser's double-click.
   */
  const pendingClickRef = useRef<{ itemId: string; time: number } | null>(null);
  const DOUBLE_CLICK_THRESHOLD = 300; // ms

  /**
   * Double-clicks arrive via two paths: the manual two-clicks-within-threshold
   * detector below (native dblclick can be swallowed by the selection
   * re-render) and the row's native onDoubleClick (needed for synthetic
   * dblclick events from automation, which don't produce two click events the
   * detector can pair). A real double-click can trigger both, so both funnel
   * through here and the second firing for the same row within the threshold
   * is dropped.
   */
  const lastDoubleClickRef = useRef<{ itemId: string; time: number } | null>(null);

  const fireItemDoubleClick = useCallback((item: T, index: number, event: React.MouseEvent) => {
    const itemId = getItemId(item);
    const now = Date.now();
    const last = lastDoubleClickRef.current;
    if (last && last.itemId === itemId && now - last.time < DOUBLE_CLICK_THRESHOLD) {
      return;
    }
    lastDoubleClickRef.current = { itemId, time: now };
    if (onItemDoubleClick) {
      onItemDoubleClick(item, index, event);
    }
  }, [getItemId, onItemDoubleClick]);

  /**
   * Native dblclick handler for rows: covers synthetic double-clicks (e.g.
   * browser automation) that dispatch a dblclick without two pairable clicks.
   */
  const handleItemNativeDoubleClick = useCallback((item: T, index: number, event: React.MouseEvent) => {
    if (event.shiftKey) {
      return;
    }
    pendingClickRef.current = null;
    selectItem(item);
    fireItemDoubleClick(item, index, event);
  }, [fireItemDoubleClick, selectItem]);

  /**
   * Handle item click. Selection fires immediately — deferring it until the
   * double-click window closes made every single click feel laggy. A second
   * click on the same row within the threshold additionally fires the
   * double-click handler (the selection side effects have already run, which
   * matches the previous end state of a double-click).
   */
  const handleItemClick = useCallback((item: T, index: number, event: React.MouseEvent) => {
    // Shift+click: select + callback, never part of a double-click
    if (event.shiftKey && onShiftClick) {
      pendingClickRef.current = null;
      selectItem(item);
      onShiftClick(item, index, event);
      return;
    }

    const itemId = getItemId(item);
    const pending = pendingClickRef.current;
    const now = Date.now();

    if (pending && pending.itemId === itemId && now - pending.time < DOUBLE_CLICK_THRESHOLD) {
      // Second click of a double-click
      pendingClickRef.current = null;
      selectItem(item);
      fireItemDoubleClick(item, index, event);
      return;
    }

    pendingClickRef.current = { itemId, time: now };
    selectItem(item);
    if (onItemClick) {
      onItemClick(item, index);
    }
  }, [fireItemDoubleClick, getItemId, onItemClick, onShiftClick, selectItem]);

  /**
   * Handle item context menu
   */
  const handleItemContextMenu = useCallback((item: T, index: number, event: React.MouseEvent) => {
    event.preventDefault();
    if (onItemContextMenu) {
      onItemContextMenu(item, index, event);
    }
  }, [onItemContextMenu]);

  const handleChecklistToggle = useCallback((itemId: string, shouldCheck: boolean) => {
    const nextCheckedIds = new Set(checkedItemIds);
    if (shouldCheck) {
      nextCheckedIds.add(itemId);
    } else {
      nextCheckedIds.delete(itemId);
    }
    setCheckedItemIds(nextCheckedIds);
    onLocalChecksChange?.(Array.from(nextCheckedIds));

    if (!onChecklist) {
      return;
    }

    const otherChecks = getOtherChecks && tabName ? getOtherChecks(tabName) : [];
    const combinedChecks = new Set<string>([...nextCheckedIds, ...otherChecks]);
    onChecklist(Array.from(combinedChecks));
  }, [checkedItemIds, getOtherChecks, onChecklist, onLocalChecksChange, tabName]);

  const handleRowDragStart = useCallback((item: T, event: React.DragEvent<HTMLDivElement>) => {
    if (!rowDrag) {
      return;
    }

    if (isTextEditDragTarget(event.target)) {
      event.preventDefault();
      return;
    }

    const isDraggable = rowDrag.isRowDraggable ? rowDrag.isRowDraggable(item) : true;
    if (!isDraggable) {
      event.preventDefault();
      return;
    }

    const payload = rowDrag.getDragPayload(item);
    activeRowDragPayloadRef.current = payload;
    const transfer = event.dataTransfer;
    transfer.effectAllowed = 'copyMove';
    transfer.setData('application/x-kms-item', JSON.stringify(payload));
    transfer.setData('text/plain', rowDrag.getPlainText?.(item) ?? payload.label ?? payload.id);
    transfer.setData('text/kms-source-type', payload.sourceType);
    transfer.setData('text/kms-id', payload.id);
    if (payload.mimeData) {
      for (const [mimeType, mimeValue] of Object.entries(payload.mimeData)) {
        transfer.setData(mimeType, mimeValue);
      }
    }
  }, [rowDrag]);

  const handleRowDragEnd = useCallback(() => {
    activeRowDragPayloadRef.current = null;
    setDropTargetItemId(null);
  }, []);

  const parseRowDropPayload = useCallback((event: React.DragEvent<HTMLDivElement>): DataListRowDragPayload | null => {
    if (activeRowDragPayloadRef.current) {
      return activeRowDragPayloadRef.current;
    }
    const raw = event.dataTransfer.getData('application/x-kms-item');
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as DataListRowDragPayload;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.sourceType !== 'string' || typeof parsed.id !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, []);

  const handleRowDragOver = useCallback((item: T, event: React.DragEvent<HTMLDivElement>) => {
    if (!rowDrop) {
      return;
    }
    const payload = parseRowDropPayload(event);
    if (!payload) {
      return;
    }
    if (rowDrop.canDrop && !rowDrop.canDrop(item, payload)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const itemId = getItemId(item);
    if (dropTargetItemId !== itemId) {
      setDropTargetItemId(itemId);
    }
  }, [dropTargetItemId, getItemId, parseRowDropPayload, rowDrop]);

  const handleRowDragLeave = useCallback((item: T, event: React.DragEvent<HTMLDivElement>) => {
    if (!rowDrop) {
      return;
    }
    const currentTarget = event.currentTarget;
    const related = event.relatedTarget as Node | null;
    if (related && currentTarget.contains(related)) {
      return;
    }
    const itemId = getItemId(item);
    if (dropTargetItemId === itemId) {
      setDropTargetItemId(null);
    }
  }, [dropTargetItemId, getItemId, rowDrop]);

  const handleRowDrop = useCallback((item: T, event: React.DragEvent<HTMLDivElement>) => {
    if (!rowDrop) {
      return;
    }
    const payload = parseRowDropPayload(event);
    setDropTargetItemId(null);
    if (!payload) {
      return;
    }
    if (rowDrop.canDrop && !rowDrop.canDrop(item, payload)) {
      return;
    }
    event.preventDefault();
    void rowDrop.onDrop(item, payload);
  }, [parseRowDropPayload, rowDrop]);

  /**
   * Calculate grid template columns from column widths
   */
  const gridTemplateColumns = useMemo(() => {
    const sizes = columns.map(col => col.width || '1fr');
    if (onChecklist) {
      sizes.unshift(CHECKBOX_COLUMN_WIDTH);
    }
    return sizes.join(' ');
  }, [columns, onChecklist]);

  const listAriaLabel = ariaLabel ?? tabName ?? 'Records';
  const DataListOuterElement = useMemo(
    () => createDataListOuterElement(listAriaLabel),
    [listAriaLabel]
  );

  /**
   * Get sort indicator for column
   */
  const getSortIndicator = useCallback((column: ColumnDefinition<T>) => {
    if (!column.sortable) return null;
    const field = String(column.field);
    if (sortState.field !== field) return null;
    return sortState.direction === 'asc' ? '↑' : '↓';
  }, [sortState]);

  const itemCount = endReached ? items.length : items.length + 1;
  const FilterComponent = filterConfig?.FilterComponent;
  const hasSummaryData = Boolean(summaryData && Object.keys(summaryData).length > 0);
  const visibleMobileSummaryColumns = useMemo(
    () => columns.filter((column) => !column.mobileHidden && summaryData?.[String(column.field)] !== undefined),
    [columns, summaryData]
  );

  /**
   * Applies an already-resolved cell write (sync return, or a settled
   * Promise) to `items`. Shared by the sync and async branches of
   * `handleCellChange` below. Pure with respect to React state — all reads
   * come from refs/args, all writes go through the `setItems` updater.
   */
  const applyResolvedCellChange = useCallback((
    index: number,
    rowId: string,
    resolved: DataListCellChangeResult<T>
  ) => {
    if (resolved === undefined) {
      return;
    }
    setItems((prev) => {
      const next = applyCellMerge(prev, index, rowId, resolved, getItemId);
      const updatedItem = next[index];
      if (updatedItem && selectedItemId !== null && getItemId(updatedItem) === selectedItemId) {
        selectedItemRef.current = updatedItem;
      }
      return next;
    });
  }, [getItemId, selectedItemId]);

  /**
   * Cell edits are optimistic-local-first: the row updates immediately and
   * `column.onChange` runs OUTSIDE the `setItems` updater (previously it ran
   * inside the updater, a side effect in a reducer that could double-fire
   * under StrictMode). When `onChange` returns a Promise, the cell is marked
   * pending (further edits to that same cell are ignored until it settles),
   * a resolved value is merged onto the row (server wins over the optimistic
   * local edit), and a rejection rolls the field back to its previous value
   * and announces the failure via the visually-hidden live region.
   */
  const handleCellChange = useCallback((index: number, column: ColumnDefinition<T>, nextValue: unknown) => {
    const current = itemsRef.current[index];
    if (!current) {
      return;
    }

    const rowId = getItemId(current);
    const fieldName = String(column.field);
    const key = cellKey(rowId, fieldName);

    if (!canEditCell(cellEditMapRef.current, key)) {
      // A previous write to this exact cell hasn't settled yet — ignore
      // further edits to it (other cells remain editable).
      return;
    }

    const previousValue = current[fieldName as keyof T];
    const updated = { ...current, [fieldName]: nextValue } as T;
    const change: DataListCellChange<T> = {
      field: fieldName,
      value: nextValue,
      item: updated,
      previousItem: current,
      index
    };

    setItems((prev) => applyCellEdit(prev, index, fieldName, nextValue));
    if (selectedItemId !== null && rowId === selectedItemId) {
      selectedItemRef.current = updated;
    }
    // A fresh interaction with this cell clears any stale error marker.
    setCellEditMap((prev) => clearCellStatus(prev, key));

    if (!column.onChange) {
      return;
    }

    const result = column.onChange(change);
    if (!(result instanceof Promise)) {
      applyResolvedCellChange(index, rowId, result);
      return;
    }

    setCellEditMap((prev) => beginPendingEdit(prev, key, previousValue));

    result.then((resolved) => {
      setCellEditMap((prev) => resolveEdit(prev, key));
      applyResolvedCellChange(index, rowId, resolved);
    }).catch(() => {
      setCellEditMap((prev) => rejectEdit(prev, key));
      setItems((prev) => {
        const next = applyCellRollback(prev, index, fieldName, previousValue, rowId, getItemId);
        const updatedItem = next[index];
        if (updatedItem && selectedItemId !== null && getItemId(updatedItem) === selectedItemId) {
          selectedItemRef.current = updatedItem;
        }
        return next;
      });
      setLiveAnnouncement(`${column.header} update failed — change reverted.`);
    });
  }, [applyResolvedCellChange, getItemId, selectedItemId]);

  const fastAddAccess = useMemo(() => {
    if (!fastAdd) {
      return { enabled: false, message: undefined as string | undefined };
    }
    const result = fastAdd.isEnabled ? fastAdd.isEnabled(mergedFilters) : true;
    return typeof result === 'boolean'
      ? { enabled: result, message: undefined as string | undefined }
      : { enabled: result.enabled, message: result.message };
  }, [fastAdd, mergedFilters]);

  const openDraft = useCallback(() => {
    if (!fastAdd) {
      return;
    }
    draftAnchorRef.current = null;
    setDraftItem(fastAdd.createDraft(mergedFilters) as T);
    setDraftErrors(new Set());
    setDraftGeneration((generation) => generation + 1);
  }, [fastAdd, mergedFilters]);

  const cancelDraft = useCallback(() => {
    draftAnchorRef.current = null;
    setDraftItem(null);
    setDraftErrors(new Set());
  }, []);

  // Open an item-anchored draft when a new fastAddRequest token arrives.
  useEffect(() => {
    if (!fastAddRequest || !fastAdd?.createDraftForItem) {
      return;
    }
    const seed = fastAdd.createDraftForItem(fastAddRequest.item, mergedFilters);
    if (!seed) {
      return;
    }
    draftAnchorRef.current = fastAddRequest.item;
    setDraftItem(seed as T);
    setDraftErrors(new Set());
    setDraftGeneration((generation) => generation + 1);
    // Only the token should retrigger: filters feeding the seed are read fresh
    // at open time, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fastAddRequest?.token]);

  // Focus the first editable control when a draft row opens or re-arms.
  useEffect(() => {
    if (!draftItem) {
      return;
    }
    const firstInput = draftRowRef.current?.querySelector<HTMLElement>('input, select, textarea');
    firstInput?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftGeneration, draftItem !== null]);

  const handleDraftCellChange = useCallback((column: ColumnDefinition<T>, nextValue: unknown) => {
    setDraftItem((prev) => {
      if (!prev) {
        return prev;
      }
      const fieldName = String(column.field);
      const updated = { ...prev, [fieldName]: nextValue } as T;
      const change: DataListCellChange<T> = {
        field: fieldName,
        value: nextValue,
        item: updated,
        previousItem: prev,
        index: -1
      };
      // Draft rows aren't part of `items` and have no cellEditMap entry, so
      // async onChange handlers aren't awaited here — a Promise result is
      // treated the same as no override (the draft's own onCommit is what
      // actually persists it).
      const override = column.onChange ? column.onChange(change) : undefined;
      if (override === undefined || override instanceof Promise) {
        return updated;
      }
      return { ...updated, ...override } as T;
    });
  }, []);

  const commitDraft = useCallback(async () => {
    if (!fastAdd || !draftItem || isCommittingDraft) {
      return;
    }
    const missing = fastAdd.requiredFields.filter(({ field }) => {
      const value = (draftItem as Record<string, unknown>)[field];
      if (typeof value === 'string') {
        return value.trim().length === 0;
      }
      if (typeof value === 'number') {
        return !Number.isFinite(value);
      }
      return value === undefined || value === null;
    });
    if (missing.length > 0) {
      setDraftErrors(new Set(missing.map((entry) => entry.field)));
      return;
    }
    setDraftErrors(new Set());
    setIsCommittingDraft(true);
    try {
      const { __draft: _draftFlag, ...payload } = draftItem as Record<string, unknown>;
      const success = await fastAdd.onCommit(payload as Partial<T>);
      if (success) {
        if (fastAdd.rearmAfterCommit) {
          // Successive entry: reopen a fresh draft from the same seed source
          // (same anchor row for anchored drafts).
          const anchor = draftAnchorRef.current;
          const seed = anchor && fastAdd.createDraftForItem
            ? fastAdd.createDraftForItem(anchor, mergedFilters)
            : fastAdd.createDraft(mergedFilters);
          setDraftItem((seed ?? null) as T | null);
          setDraftGeneration((generation) => generation + 1);
        } else {
          setDraftItem(null);
        }
        setFastAddReloadCounter((count) => count + 1);
      }
    } finally {
      setIsCommittingDraft(false);
    }
  }, [draftItem, fastAdd, isCommittingDraft, mergedFilters]);

  const resolveItemAriaLabel = useCallback((item: T, index: number): string => {
    if (getItemAriaLabelProp) {
      return getItemAriaLabelProp(item, index);
    }
    return getDefaultItemAriaLabel(item, index, columns);
  }, [columns, getItemAriaLabelProp]);

  /**
   * Row renderer
   */
  const itemData = useMemo<DataListRowData<T>>(() => ({
    items,
    columns,
    selectedIndex,
    gridTemplateColumns,
    isMobile,
    hasMobileRow2,
    rowDrag,
    rowDrop,
    dropTargetItemId,
    cellEditMap,
    onChecklist,
    checkedItemIds,
    getChecklistMarkerColor,
    getChecklistMarkerStatus,
    getItemId,
    handleChecklistToggle,
    handleRowDragStart,
    handleRowDragEnd,
    handleRowDragOver,
    handleRowDragLeave,
    handleRowDrop,
    handleItemClick,
    handleItemNativeDoubleClick,
    handleItemContextMenu,
    getItemAriaLabel: resolveItemAriaLabel,
    handleCellChange,
    getEditAccess
  }), [
    items,
    columns,
    selectedIndex,
    gridTemplateColumns,
    isMobile,
    hasMobileRow2,
    rowDrag,
    rowDrop,
    dropTargetItemId,
    cellEditMap,
    onChecklist,
    checkedItemIds,
    getChecklistMarkerColor,
    getChecklistMarkerStatus,
    getItemId,
    handleChecklistToggle,
    handleRowDragStart,
    handleRowDragEnd,
    handleRowDragOver,
    handleRowDragLeave,
    handleRowDrop,
    handleItemClick,
    handleItemNativeDoubleClick,
    handleItemContextMenu,
    resolveItemAriaLabel,
    handleCellChange,
    getEditAccess
  ]);

  const Row = useCallback(({ index, style, data }: ListChildComponentProps<DataListRowData<T>>) => {
    const { items, columns } = data;
    const item = items[index];
    const isLoaderRow = index >= items.length;
    const isSelected = index === data.selectedIndex;
    const isDraggable = !isLoaderRow && Boolean(data.rowDrag) && (data.rowDrag?.isRowDraggable ? data.rowDrag.isRowDraggable(item) : true);
    const itemId = !isLoaderRow ? data.getItemId(item) : '';
    const isDropTarget = !isLoaderRow && data.dropTargetItemId === itemId;
    const ariaLabel = !isLoaderRow ? data.getItemAriaLabel(item, index) : 'Loading row';
    const editAccess = !isLoaderRow ? data.getEditAccess?.(item) : undefined;
    const isEditDisabled = editAccess != null && (
      typeof editAccess === 'boolean' ? !editAccess : !editAccess.allowed
    );
    const editDisabledMessage = typeof editAccess === 'object' ? editAccess.message : undefined;
    const rowStyle = {
      ...style,
      '--data-list-row-height': typeof style.height === 'number' ? `${style.height}px` : style.height
    } as React.CSSProperties;
    const handleRowPointerStartCapture = (event: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
      if (isDraggable && isTextEditDragTarget(event.target)) {
        disableRowDragDuringTextEditGesture(event.currentTarget, isDraggable);
      }
    };

    if (isLoaderRow) {
      return (
        <div
          className="data-list-row data-list-row-loading"
          style={{ ...rowStyle, gridTemplateColumns: data.gridTemplateColumns }}
          role="status"
          aria-label={ariaLabel}
        >
          <div className="data-list-cell placeholder" aria-busy="true">Loading…</div>
        </div>
      );
    }

    const checklistMarkerColor = data.getChecklistMarkerColor
      ? data.getChecklistMarkerColor(item)
      : undefined;
    const checklistMarkerStatus = data.getChecklistMarkerStatus
      ? data.getChecklistMarkerStatus(item)
      : undefined;
    const checklistInput = (
      <input
        type="checkbox"
        className="data-list-check-input"
        checked={data.checkedItemIds.has(data.getItemId(item))}
        aria-label={`Select ${ariaLabel}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
        onChange={(event) => data.handleChecklistToggle(data.getItemId(item), event.target.checked)}
      />
    );
    const checklistControl = checklistMarkerColor ? (
      <span
        className="data-list-check-status-marker"
        style={{ '--data-list-check-marker-color': checklistMarkerColor } as React.CSSProperties}
        data-status={checklistMarkerStatus?.status}
        data-overdue={checklistMarkerStatus ? String(Boolean(checklistMarkerStatus.overdue)) : undefined}
        aria-label={checklistMarkerStatus?.status ? `Status: ${checklistMarkerStatus.status}` : undefined}
      >
        {checklistInput}
      </span>
    ) : checklistInput;

    if (data.isMobile) {
      const row1Cols = columns.filter((c: ColumnDefinition<T>) => !c.mobileHidden && c.mobileRow !== 2);
      const row2Cols = data.hasMobileRow2 ? columns.filter((c: ColumnDefinition<T>) => !c.mobileHidden && c.mobileRow === 2) : [];
      const renderMobileCell = (column: ColumnDefinition<T>, colIndex: number) => {
        const fieldName = String(column.field);
        const value = item[column.field as keyof T];
        const isEditable = column.editable
          ? (typeof column.editable === 'function' ? column.editable(item) : column.editable)
          : false;
        const cellStatusEntry = data.cellEditMap.get(cellKey(itemId, fieldName));
        const renderFn = column.mobileRender ?? column.render;
        const cellValue = isEditable && column.editRenderer
          ? column.editRenderer({
              value,
              item,
              index,
              field: fieldName,
              onChange: (next) => data.handleCellChange(index, column, next),
              disabled: cellStatusEntry?.status === 'pending',
              status: cellStatusEntry?.status
            })
          : renderFn ? renderFn(value, item) : value;
        const label = column.mobileHeader ?? column.header;
        return (
          <div key={colIndex} className="data-list-cell-mobile" style={column.mobileCellStyle}>
            {label && <span className="data-list-cell-mobile-label">{label}</span>}
            <div className="data-list-cell-mobile-value">{cellValue}</div>
          </div>
        );
      };
      return (
        <div
          className={`data-list-row-mobile ${isSelected ? 'data-list-row-selected' : ''} ${isDropTarget ? 'data-list-row-drop-target' : ''} ${isEditDisabled ? 'data-list-row-edit-disabled' : ''}`}
          style={rowStyle}
          onClick={(event) => data.handleItemClick(item, index, event)}
          onDoubleClick={(event) => data.handleItemNativeDoubleClick(item, index, event)}
          onContextMenu={(event) => data.handleItemContextMenu(item, index, event)}
          role="option"
          aria-selected={isSelected}
          aria-label={ariaLabel}
          title={editDisabledMessage}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              data.handleItemClick(item, index, event as unknown as React.MouseEvent);
            }
          }}
        >
          <div className="data-list-mobile-row1">
            {data.onChecklist && (
              <div className="data-list-check-cell">
                {checklistControl}
              </div>
            )}
            {row1Cols.map(renderMobileCell)}
          </div>
          {data.hasMobileRow2 && row2Cols.length > 0 && (
            <div className="data-list-mobile-row2">
              {row2Cols.map(renderMobileCell)}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        className={`data-list-row ${isSelected ? 'data-list-row-selected' : ''} ${isDraggable ? 'data-list-row-draggable' : ''} ${isDropTarget ? 'data-list-row-drop-target' : ''} ${isEditDisabled ? 'data-list-row-edit-disabled' : ''}`}
        style={{ ...rowStyle, gridTemplateColumns: data.gridTemplateColumns }}
        onClick={(event) => data.handleItemClick(item, index, event)}
        onDoubleClick={(event) => data.handleItemNativeDoubleClick(item, index, event)}
        onContextMenu={(event) => data.handleItemContextMenu(item, index, event)}
        title={editDisabledMessage}
        draggable={isDraggable}
        onPointerDownCapture={handleRowPointerStartCapture}
        onMouseDownCapture={handleRowPointerStartCapture}
        onDragStart={isDraggable ? (event) => data.handleRowDragStart(item, event) : undefined}
        onDragEnd={data.rowDrag ? data.handleRowDragEnd : undefined}
        onDragOver={data.rowDrop ? (event) => data.handleRowDragOver(item, event) : undefined}
        onDragLeave={data.rowDrop ? (event) => data.handleRowDragLeave(item, event) : undefined}
        onDrop={data.rowDrop ? (event) => data.handleRowDrop(item, event) : undefined}
        role="option"
        aria-selected={isSelected}
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            data.handleItemClick(item, index, event as unknown as React.MouseEvent);
          }
        }}
      >
        {data.onChecklist && (
          <div className="data-list-cell data-list-check-cell">
            {checklistControl}
          </div>
        )}
        {columns.map((column: ColumnDefinition<T>, colIndex: number) => {
          const fieldName = String(column.field);
          const value = item[column.field as keyof T];
          const isEditable = column.editable
            ? (typeof column.editable === 'function' ? column.editable(item) : column.editable)
            : false;

          if (isEditable) {
            const normalizedValue = value === null || value === undefined
              ? ''
              : (typeof value === 'string' || typeof value === 'number')
                ? value
                : String(value);
            const handleValueChange = (next: unknown) => {
              data.handleCellChange(index, column, next);
            };
            const cellStatusEntry = data.cellEditMap.get(cellKey(itemId, fieldName));
            const isCellPending = cellStatusEntry?.status === 'pending';
            const hasCellError = cellStatusEntry?.status === 'error';
            const editContent = column.editRenderer
              ? column.editRenderer({
                  value,
                  item,
                  index,
                  field: fieldName,
                  onChange: handleValueChange,
                  disabled: isCellPending,
                  status: cellStatusEntry?.status
                })
              : (
                <input
                  type={typeof value === 'number' ? 'number' : 'text'}
                  className="data-list-cell-input"
                  data-column={fieldName}
                  value={normalizedValue}
                  disabled={isCellPending}
                  aria-invalid={hasCellError || undefined}
                  onClick={(event) => {
                    // Shift+click is the row-level global-filter gesture; let it
                    // reach the row instead of being swallowed by the editor.
                    if (!event.shiftKey) {
                      event.stopPropagation();
                    }
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => handleValueChange(event.target.value)}
                />
              );

            return (
              <div
                key={colIndex}
                className={`data-list-cell data-list-cell-editable ${isCellPending ? 'data-list-cell-pending' : ''} ${hasCellError ? 'data-list-cell-error' : ''}`}
                data-column={fieldName}
                onClick={(event) => {
                  if (!event.shiftKey) {
                    event.stopPropagation();
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {editContent}
              </div>
            );
          }

          const rendered = column.render ? column.render(value, item) : value;
          return (
            <div key={colIndex} className="data-list-cell" title={String(value || '')} style={column.cellStyle}>
              {rendered}
            </div>
          );
        })}
      </div>
    );
  }, []);

  return (
    <div className={`data-list-container ${className}`}>
      <div className="data-list-visually-hidden" role="alert" aria-live="assertive">
        {liveAnnouncement}
      </div>
      <div className="data-list-table">
        {FilterComponent && filterConfig && (
          <div className="data-list-filters">
            <FilterComponent
              filters={localFilters}
              setFilters={setLocalFilters}
              resetFilters={resetFilters}
              {...(filterConfig.filterProps ?? {})}
            />
          </div>
        )}
        <div className="data-list-main">
          <div className="data-list-main-content">
            {!isMobile && (
              <div className="data-list-header" style={{ gridTemplateColumns }}>
                {onChecklist && (
                  <div className="data-list-header-cell data-list-check-header" aria-hidden="true" />
                )}
                {columns.map((column, index) => {
                  if (!column.sortable) {
                    return (
                      <div key={index} className="data-list-header-cell">
                        <span>{column.header}</span>
                      </div>
                    );
                  }
                  const field = String(column.field);
                  const isActiveSort = sortState.field === field;
                  const ariaSort: React.AriaAttributes['aria-sort'] = isActiveSort
                    ? (sortState.direction === 'asc' ? 'ascending' : 'descending')
                    : 'none';
                  return (
                    <div key={index} role="columnheader" aria-sort={ariaSort} className="data-list-header-cell sortable">
                      <button
                        type="button"
                        className="data-list-header-button"
                        onClick={() => handleHeaderClick(column)}
                      >
                        <span>{column.header}</span>
                        {getSortIndicator(column) && (
                          <span className="data-list-sort-indicator" aria-hidden="true">{getSortIndicator(column)}</span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {loadError && (
              <div className="data-list-error" role="alert">
                <span className="data-list-error-message">Failed to load items: {loadError}</span>
                <button type="button" className="data-list-error-retry" onClick={handleRetryLoad}>
                  Retry
                </button>
              </div>
            )}
            {!isMobile && fastAdd && draftItem && (
              <div
                ref={draftRowRef}
                className="data-list-row data-list-row-draft"
                style={{ gridTemplateColumns, height: rowHeight }}
                role="row"
                aria-label="New record draft — Enter saves, Escape cancels"
                data-testid="data-list-fast-add-row"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
                    event.preventDefault();
                    event.stopPropagation();
                    void commitDraft();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelDraft();
                  }
                }}
              >
                {onChecklist && (
                  <div className="data-list-cell data-list-check-cell" aria-hidden="true" />
                )}
                {columns.map((column, colIndex) => {
                  const fieldName = String(column.field);
                  const value = (draftItem as Record<string, unknown>)[fieldName];
                  const isEditable = column.editable
                    ? (typeof column.editable === 'function' ? column.editable(draftItem) : column.editable)
                    : false;
                  const hasError = draftErrors.has(fieldName);

                  if (!isEditable) {
                    return (
                      <div key={colIndex} className="data-list-cell data-list-cell-draft-static">
                        {column.render ? column.render(value, draftItem) : (value as React.ReactNode)}
                      </div>
                    );
                  }

                  const handleValueChange = (next: unknown) => handleDraftCellChange(column, next);
                  const editContent = column.editRenderer
                    ? column.editRenderer({ value, item: draftItem, index: -1, field: fieldName, onChange: handleValueChange })
                    : (
                      <input
                        type={typeof value === 'number' ? 'number' : 'text'}
                        className="data-list-cell-input"
                        data-column={fieldName}
                        placeholder={column.header}
                        value={value === null || value === undefined ? '' : String(value)}
                        disabled={isCommittingDraft}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => handleValueChange(event.target.value)}
                      />
                    );

                  return (
                    <div
                      key={colIndex}
                      className={`data-list-cell data-list-cell-editable ${hasError ? 'data-list-cell-draft-error' : ''}`}
                      data-column={fieldName}
                    >
                      {editContent}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="data-list-list-wrapper" ref={wrapperRef}>
              {items.length === 0 && isListComplete && !loadError && !draftItem && (
                <div className="data-list-empty" role="status">
                  No records match the current filters.
                </div>
              )}
              <InfiniteLoader
                key={`${querySignature}-${isMobile ? 'm' : 'd'}`}
                isItemLoaded={isItemLoaded}
                itemCount={itemCount}
                loadMoreItems={loadMoreItems}
                minimumBatchSize={batchSize}
                threshold={20}
              >
                {({ onItemsRendered, ref }: { onItemsRendered: (props: ListOnItemsRenderedProps) => void, ref: any }) => (
                  <List
                    className="data-list-list"
                    height={Math.max(1, size.height)}
                    itemData={itemData}
                    itemCount={itemCount}
                    itemSize={effectiveItemSize}
                    width={Math.max(1, size.width)}
                    onScroll={({ scrollOffset }: ListOnScrollProps) => {
                      scrollOffsetRef.current = scrollOffset;
                    }}
                    onItemsRendered={onItemsRendered}
                    ref={(instance: any) => {
                      listRef.current = instance;
                      if (typeof ref === 'function') {
                        ref(instance);
                        return;
                      }
                      if (ref && typeof ref === 'object') {
                        ref.current = instance;
                      }
                    }}
                    outerElementType={DataListOuterElement}
                  >
                    {Row}
                  </List>
                )}
              </InfiniteLoader>
              {onAddClick && (
                <button
                  type="button"
                  className={`data-list-add-button ${hasSummaryData ? 'with-summary-row' : ''}`}
                  onClick={onAddClick}
                  title="Add new record"
                  aria-label="Add new record"
                >
                  <img src={PlusIcon} alt="" aria-hidden="true" />
                </button>
              )}
              {exportConfig && !isMobile && (
                <div className={`data-list-export-buttons ${hasSummaryData ? 'with-summary-row' : ''}`}>
                  {(['csv', 'xlsx'] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      className="data-list-export-button"
                      title={exportConfig.title ?? `Export the current view as ${format.toUpperCase()} (honours active filters)`}
                      onClick={() => {
                        const sort = sortState.field && sortState.direction
                          ? { field: sortState.field, direction: sortState.direction }
                          : undefined;
                        const anchor = document.createElement('a');
                        anchor.href = exportConfig.buildUrl(format, { filters: mergedFilters, sort });
                        anchor.rel = 'noopener';
                        document.body.appendChild(anchor);
                        anchor.click();
                        anchor.remove();
                      }}
                    >
                      ↓ {format.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              {fastAdd && !isMobile && (
                <button
                  type="button"
                  className={`data-list-add-button data-list-fast-add-button ${hasSummaryData ? 'with-summary-row' : ''}`}
                  onClick={() => (draftItem ? cancelDraft() : openDraft())}
                  disabled={(!fastAddAccess.enabled && !draftItem) || isCommittingDraft}
                  title={draftItem
                    ? 'Cancel quick add'
                    : fastAddAccess.enabled
                      ? 'Quick add — type into the new row, Enter saves'
                      : fastAddAccess.message ?? 'Quick add unavailable'}
                  aria-label={draftItem ? 'Cancel quick add' : 'Quick add row'}
                >
                  {draftItem ? '×' : '⚡'}
                </button>
              )}
            </div>
            {hasSummaryData && summaryData && (
              isMobile ? (
                <div className="data-list-summary-mobile" role="status" aria-label="List summary">
                  {visibleMobileSummaryColumns.map((column, index) => {
                    const fieldName = String(column.field);
                    const value = summaryData[fieldName] ?? '';
                    const label = column.mobileHeader ?? column.header;
                    return (
                      <div key={index} className="data-list-summary-mobile-cell">
                        {label && <span className="data-list-summary-mobile-label">{label}</span>}
                        <span className="data-list-summary-mobile-value" title={value}>{value}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="data-list-summary-row" style={{ gridTemplateColumns }} role="status" aria-label="List summary">
                  {onChecklist && (
                    <div className="data-list-summary-cell data-list-check-summary" aria-hidden="true" />
                  )}
                  {columns.map((column, index) => {
                    const value = summaryData[String(column.field)] ?? '';
                    return (
                      <div key={index} className="data-list-summary-cell" title={value}>
                        {value}
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};


import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { DataList, ColumnDefinition, DataListQuery, DataSourceParams, DataSourceResult } from './DataList';
import type { DataListFastAddConfig, DataListFilterConfig, DataListRowDragConfig, DataListRowDropConfig, DataListSummaryDataSource } from './DataList';
import { RecordForm } from './RecordForm';
import { ContextMenu } from './ContextMenu';
import { generateRandomId, toReadableText } from '../utility';
import { clampSplitRatioForWidth } from './splitRatio';
import { stableSerialize } from '../utils/stableSerialize';
import './DataTabManager.css';

/**
 * Tab configuration for a single tab type
 */
/**
 * Props passed to custom create form components.
 */
export interface CreateFormProps {
  /** JSON Schema defining the form fields (if createSchema is provided on TabConfig). */
  schema?: Record<string, any>;
  /** Initial values for the form fields. Used in edit mode to pre-populate the form. */
  initialValues?: Record<string, any>;
  /**
   * Global filter currently applied to the parent list tab.
   * Useful for defaulting create/edit fields (e.g. create under a filtered project/room).
   */
  globalFilter?: Record<string, any>;
  /** Handler to call when the form is submitted. Returns true on success. */
  onSubmit: (data: Record<string, any>) => Promise<boolean>;
  /** Handler to call when the user cancels/closes the form. */
  onCancel: () => void;
  /** Title to display in the form header. */
  title: string;
  /**
   * Fetch related records from another tab for use in dropdown fields.
   * Uses global filters but excludes local filter inputs.
   * @param tabName - The configKey of the tab to fetch from (e.g., 'projects')
   * @param fields - Array of field names to include in returned records
   * @returns Array of records with only the specified fields
   */
  fetchRelatedRecords?: (tabName: string, fields: string[]) => Promise<Record<string, any>[]>;
  /**
   * Callback to delete the current record (edit mode only).
   * When provided, a delete button is rendered in the form.
   */
  onDelete?: () => void;
  /**
   * Callback to report when the form has unsaved changes.
   * Used by the tab manager to warn before closing tabs with unsaved data.
   */
  onDirtyChange?: (isDirty: boolean) => void;
  /**
   * Component context resolved from the tab config's componentContext property.
   * Provides uploadEditor configuration and other context to custom form components.
   */
  componentContext?: Record<string, any>;
}

/**
 * Context published by DataTabManager so descendant forms can reactively read
 * records from other tabs without any tab-specific knowledge leaking outside.
 */
interface RelatedRecordsContextValue {
  /** Same behavior as the `fetchRelatedRecords` form prop. */
  fetchRelatedRecords: (tabName: string, fields: string[]) => Promise<Record<string, any>[]>;
  /** Whether a tab config with this key is registered. */
  hasTab: (tabName: string) => boolean;
  /** Per-config-key revision counter, bumped whenever that tab's records change. */
  dataVersions: Record<string, number>;
}

const RelatedRecordsContext = createContext<RelatedRecordsContextValue | null>(null);

/**
 * Reactive counterpart to the `fetchRelatedRecords` form prop. Returns the records
 * of another tab (projected to `fields`) and automatically re-fetches whenever that
 * tab's records are created, edited, or deleted through DataTabManager.
 *
 * Returns `null` when there is no DataTabManager context or the requested tab is not
 * registered — letting callers distinguish "no such tab" from "no records yet" (an
 * empty array). This keeps tabs pluggable: a form can ask for a tab that may or may
 * not be present in the current application config.
 */
export const useRelatedRecords = (
  tabName: string,
  fields: string[]
): Record<string, any>[] | null => {
  const ctx = useContext(RelatedRecordsContext);
  const fetchRelatedRecords = ctx?.fetchRelatedRecords;
  const hasTab = Boolean(ctx?.hasTab(tabName));
  const version = ctx?.dataVersions[tabName] ?? 0;
  // Stable dependency for the field list; the effect reads the latest via a ref.
  // NUL escape keeps the key collision-proof without a raw NUL byte in source.
  const fieldsKey = fields.join('\u0000');
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const [records, setRecords] = useState<Record<string, any>[]>([]);
  // Signature of the last applied result, so an unchanged re-fetch (e.g. after a
  // tab switch) keeps the same array reference and does not perturb consumers.
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!fetchRelatedRecords || !hasTab) {
      return;
    }
    let cancelled = false;
    void fetchRelatedRecords(tabName, fieldsRef.current)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const signature = stableSerialize(result);
        if (signature === lastSignatureRef.current) {
          return; // Content unchanged — preserve the existing reference.
        }
        lastSignatureRef.current = signature;
        setRecords(result);
      })
      .catch((error) => {
        console.error(`useRelatedRecords: failed to load "${tabName}"`, error);
        if (!cancelled) {
          lastSignatureRef.current = stableSerialize([]);
          setRecords([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRelatedRecords, hasTab, tabName, fieldsKey, version]);

  return hasTab ? records : null;
};

export type SchemaFormMode = 'create' | 'edit';

export interface SchemaFormChangeHelpers {
  setValue: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  setSchema: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  getValue: () => Record<string, any>;
  getSchema: () => Record<string, any>;
}

export interface SchemaFormChangeMeta<T = any> {
  mode: SchemaFormMode;
  configKey: string;
  existingItem?: T;
}

export interface SchemaFormChangeEvent<T = any> extends SchemaFormChangeMeta<T> {
  value: Record<string, any>;
  path: string[];
  errors: unknown;
  action: number;
  helpers: SchemaFormChangeHelpers;
}

export type SchemaFormChangeHandler<T = any> = (event: SchemaFormChangeEvent<T>) => void;

export interface EditAccessResult {
  allowed: boolean;
  message?: string;
}

/**
 * Imperative actions a host can hold for one tab config, obtained via
 * TabConfig.registerTabActions. Lets UI outside the tab (e.g. a bulk-action
 * button on another tab) drive this tab.
 */
export interface TabExternalActions {
  /**
   * Open a create tab for this config, parented to its open list tab.
   * Returns false when no list tab for the config is open or the config
   * cannot create records (e.g. write permission withheld).
   */
  openCreateTab: (options?: { title?: string; initialValues?: Record<string, any> }) => boolean;
}

export interface TabConfig<T = any> {
  dataSource: (params: DataSourceParams) => Promise<DataSourceResult<T>>;
  columns: ColumnDefinition<T>[];
  detailComponent: React.FC<{
    item: T;
    onClose: () => void;
    onEdit?: () => void;
    /**
     * Report a record the detail panel saved directly, so the tab manager can
     * refresh the parent list and any open tabs showing the same record.
     */
    onItemSaved?: (item: T) => void;
  }>;
  getItemId: (item: T) => string;
  /**
   * Optional display title used for list tabs. Defaults to a readable version of the config key.
   */
  displayTitle?: string;
  /**
   * Optional field name used to display the selected record title for global-filter labels.
   * When omitted, DataTabManager falls back to getItemTitle(), then common title/name fields,
   * then getItemId().
   */
  titleField?: keyof T | string;
  /**
   * Optional helper used for detail/edit titles and global-filter source labels.
   */
  getItemTitle?: (item: T) => string;
  /**
   * Optional helper used to label list rows for accessibility / automation.
   */
  getItemAriaLabel?: (item: T, index: number) => string;
  /**
   * When true, the tab's list view will auto-select the sole row when the result set
   * contains exactly one item. Multi-item lists never default a selection.
   * Pass 'always' to auto-select the first row of any non-empty result set.
   */
  autoSelectFirstRow?: boolean | 'always';
  /**
   * Optional field mapping used when this tab contributes global filter values.
   * Keys are local record fields; values are global filter field names.
   */
  globalFilterSets?: Record<string, string>;
  /**
   * Optional field mapping used when this tab receives global filter values.
   * Keys are global filter field names; values are local filter field names.
   */
  globalFilterReceives?: Record<string, string>;
  /**
   * Optional legacy field mapping for global filters.
   * Keys are local record fields; values are global filter field names.
   */
  globalFilterFieldMap?: Record<string, string>;
  /**
   * Optional filter UI configuration rendered by DataList.
   */
  filterConfig?: DataListFilterConfig;
  /**
   * Optional hook to observe the merged filters + sort state from the list view.
   */
  onQueryChange?: (query: DataListQuery) => void;
  /**
   * Optional summary data source for a sticky bottom row keyed by column field.
   */
  getSummaryData?: DataListSummaryDataSource;
  /**
   * Optional initial sort configuration. When provided, the list will start with this sort applied.
   */
  initialSort?: { field: string; direction: 'asc' | 'desc' };
  onItemContextMenu?: (item: T, index: number, event: React.MouseEvent) => void;
  /**
   * Structured context menu options for list rows.
   * Combined with DataTabManager's built-in options (e.g. "Make global filter").
   */
  getContextMenuOptions?: (
    item: T,
    index: number,
    helpers: {
      closeMenu: () => void;
      openCreateTab: (options?: { title?: string; initialValues?: Record<string, any> }) => void;
      /** Open the read-only detail tab for the row (replaces any open detail tab for the same list). */
      openDetailTab: () => void;
      /**
       * Delete the row via the tab's onDelete (which owns any confirm prompt),
       * then refresh the list. Undefined when the tab has no onDelete.
       */
      deleteItem?: () => Promise<void>;
      /**
       * Open a fast-add draft anchored to this row (closes the menu).
       * Undefined when the tab's fastAdd config has no createDraftForItem.
       */
      openFastAddForItem?: () => void;
    }
  ) => { label: string; onClick: () => void }[];
  /**
   * Optional handler for checklist selections in the tab's list view.
   */
  onChecklist?: (checkedIds: string[]) => void;
  /**
   * Optional helper to include checks from other tabs when reporting selections.
   */
  getOtherChecks?: (tabName: string) => string[];
  /**
   * Optional checklist marker colour. Forwarded to DataList for tab-specific
   * status indicators around checklist checkboxes.
   */
  getChecklistMarkerColor?: (item: T) => string | undefined;
  /**
   * Optional machine-readable status for the checklist marker, forwarded to
   * DataList as `data-status`/`data-overdue`/`aria-label` for automated tests.
   */
  getChecklistMarkerStatus?: (item: T) => { status?: string; overdue?: boolean } | undefined;
  /**
   * Optional token to clear checklist selections in the list.
   * Increment/change to request DataList clear checked rows.
   */
  checklistResetKey?: number | string;
  /**
   * Optional registration point for hosts that need to drive this tab from
   * outside it (see TabExternalActions). Called with the actions whenever they
   * (re)bind and with null on cleanup.
   */
  registerTabActions?: (actions: TabExternalActions | null) => void;
  /**
   * Optional row-selection observer for list tabs.
   * Useful for side-effect-only tabs that should react to row selection.
   */
  onSelectionChange?: (item: T | null) => void;
  /**
   * When true, selecting an already-selected row still invokes onSelectionChange.
   * Useful for tabs that need side effects on repeated row activation.
   */
  notifyOnReselect?: boolean;
  /**
   * Optional override to disable automatic detail/edit opening on row double-click.
   * Defaults to true.
   */
  openDetailOnDoubleClick?: boolean;
  /**
   * Optional inline fast-add configuration forwarded to DataList (quick-add
   * draft row pinned above the list).
   */
  fastAdd?: DataListFastAddConfig<T>;
  /**
   * Optional row drag configuration for DataList.
   */
  rowDrag?: DataListRowDragConfig<T>;
  /**
   * Optional row drop configuration for DataList.
   */
  rowDrop?: DataListRowDropConfig<T>;
  buildGlobalFilter?: (context: GlobalFilterContext) => Record<string, any> | null | undefined;
  /**
   * Optional row height override passed to DataList.
   */
  rowHeight?: number;
  /**
   * Optional mobile row height (px) when columns span two sub-rows. Passed to DataList.
   */
  mobileRowHeight?: number;
  /**
   * Optional className applied to the DataList container for tab-specific styling.
   */
  dataListClassName?: string;
  /**
   * Optional JSON Schema for creating/editing records.
   * When provided, a floating "+" button appears on the list and clicking it opens a create form.
   * The same schema is used for both create and edit forms.
   */
  schema?: Record<string, any>;
  /**
   * Optional JSON Schema override used for edit forms only.
   * Use when edit mode needs different field behaviour (e.g. fields that are
   * editable on create but read-only once the record exists). Falls back to
   * `schema` when omitted.
   */
  editSchema?: Record<string, any>;
  /**
   * Optional custom component for the create form.
   * If not provided, uses the default RecordForm component with schema.
   */
  createComponent?: React.FC<CreateFormProps>;
  /**
   * Optional custom component for the edit form.
   * If not provided, uses the default RecordForm component with schema.
   */
  editComponent?: React.FC<CreateFormProps>;
  /**
   * Optional per-record edit access check.
   * Return false or { allowed: false, message } to block edit-tab opening for the item.
   */
  getEditAccess?: (item: T) => boolean | EditAccessResult;
  /**
   * Handler called when a record is created or updated.
   * @param data - The form data submitted by the user
   * @param existingItem - If provided, this is an update operation; otherwise it's a create
   * @returns The created/updated item on success, or null on failure
   */
  onUpsert?: (data: Record<string, any>, existingItem?: T) => Promise<T | null>;
  /**
   * Optional handler to delete a record. When provided, edit forms receive an onDelete callback.
   * The handler should confirm with the user and return true if the record was deleted.
   */
  onDelete?: (item: T) => Promise<boolean>;
  /**
   * Optional hook to drop any caches sitting behind this tab's dataSource.
   * DataTabManager calls it after every successful create/edit/delete of this
   * tab's records — immediately before triggering the list refetch — so the
   * refreshed list is guaranteed to reflect the change. Tabs whose dataSource
   * queries the backend directly don't need it.
   */
  invalidateData?: () => void;
  /**
   * Optional SchemaSubmitForm onChange handler for generic create/edit forms.
   * Not used when a custom create/edit component is supplied.
   */
  onChange?: SchemaFormChangeHandler<T>;
  /**
   * Optional component context passed through to InputForm via RecordForm.
   * Accepts a static object or a function that receives the current item
   * (undefined for create, the item for edit) and returns the context.
   * Use this to provide uploadEditor configuration, slider contexts, etc.
   */
  componentContext?: Record<string, any> | ((item?: T) => Record<string, any>);
}

export interface GlobalFilterContext {
  sourceItem: unknown;
  sourceConfigKey: string;
  sourceTabId: string;
  sources: Array<{
    sourceItem: unknown;
    sourceConfigKey: string;
    sourceTabId: string;
  }>;
}

export interface DataTabInfo {
  id: string;
  type: 'list' | 'detail' | 'create' | 'edit';
  title: string;
  configKey: string;
}

export interface GlobalFilterSourceInfo {
  sourceTabId: string;
  sourceConfigKey: string;
  sourceTabTitle: string;
  item: unknown;
  valueLabel: string;
  contribution?: Record<string, unknown>;
}

export interface GlobalFilterChangeEvent {
  filter: Record<string, unknown>;
  sources: GlobalFilterSourceInfo[];
  valueLabel: string;
}

export interface DataTabListQuerySnapshot {
  tabKey: string;
  query: DataListQuery;
  dataSource: (params: DataSourceParams) => Promise<DataSourceResult<unknown>>;
}

export interface ItemReceiverPanelConfig {
  title?: string;
  renderPanel: () => React.ReactNode;
  isActiveByDefault?: boolean;
  visibleTabConfigKeysWhenActive: string[];
  visibleTabConfigKeysWhenInactive?: string[];
  splitDefault?: number;
  minLeftPx?: number;
  minRightPx?: number;
  toggleLabel?: { on: string; off: string };
  /**
   * Optional className applied to left-pane DataList roots while receiver mode is active.
   */
  leftPaneDataListClassNameWhenActive?: string;
  /**
   * When set, DataTabManager populates this ref with a function that programmatically
   * resizes the split so the right (receiver) pane is the given number of CSS pixels wide.
   */
  setRightPaneWidthPxRef?: React.MutableRefObject<((desiredRightPx: number) => void) | null>;
  /**
   * Optional callback fired whenever receiver mode is toggled.
   */
  onActiveChange?: (active: boolean) => void;
  /**
   * Optional ref populated with a setter for receiver mode.
   */
  setReceiverActiveRef?: React.MutableRefObject<((active: boolean) => void) | null>;
}

/**
 * Build a global filter object from a source record using a field map.
 */
const mapRecordToGlobalFilter = (
  item: unknown,
  fieldMap?: Record<string, string>
): Record<string, unknown> | undefined => {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  if (!fieldMap) {
    return record;
  }
  if (Object.keys(fieldMap).length === 0) {
    return {};
  }

  const mapped: Record<string, unknown> = {};
  for (const [localField, globalField] of Object.entries(fieldMap)) {
    if (!globalField) {
      continue;
    }
    const value = record[localField];
    if (value !== null && value !== undefined) {
      mapped[globalField] = value;
    }
  }
  return mapped;
};

/**
 * Build a local filter object for a tab from a global filter using a field map.
 */
const mapGlobalFilterToLocal = (
  globalFilter: unknown,
  fieldMap?: Record<string, string>
): Record<string, unknown> | undefined => {
  if (!globalFilter || typeof globalFilter !== 'object') {
    return undefined;
  }

  const filterRecord = globalFilter as Record<string, unknown>;
  if (!fieldMap || Object.keys(fieldMap).length === 0) {
    return filterRecord;
  }

  const mapped: Record<string, unknown> = {};
  for (const [localField, globalField] of Object.entries(fieldMap)) {
    if (!globalField) {
      continue;
    }
    const value = filterRecord[globalField];
    if (value !== null && value !== undefined) {
      mapped[localField] = value;
    }
  }
  return mapped;
};

/**
 * Build a local filter from an explicit global-to-local receive map.
 */
const mapReceivedGlobalFilterToLocal = (
  globalFilter: unknown,
  receives?: Record<string, string>
): Record<string, unknown> | undefined => {
  if (!globalFilter || typeof globalFilter !== 'object') {
    return undefined;
  }

  const filterRecord = globalFilter as Record<string, unknown>;
  if (!receives || Object.keys(receives).length === 0) {
    return undefined;
  }

  const mapped: Record<string, unknown> = {};
  for (const [globalField, localField] of Object.entries(receives)) {
    if (!localField) {
      continue;
    }
    const value = filterRecord[globalField];
    if (value !== null && value !== undefined) {
      mapped[localField] = value;
    }
  }
  return mapped;
};

/**
 * Convert arbitrary tab keys to deterministic test-id tokens.
 */
const toTestIdToken = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const resolveListTabTitle = (configKey: string, tabConfig?: TabConfig): string => {
  return tabConfig?.displayTitle || toReadableText(configKey);
};

const resolveCreateTabTitle = (configKey: string, tabConfig?: TabConfig): string => {
  return `New ${resolveListTabTitle(configKey, tabConfig).replace(/s$/, '')}`;
};

/**
 * Internal tab state representation
 */
interface DataTabState {
  id: string;
  type: 'list' | 'detail' | 'create' | 'edit';
  title: string;
  configKey: string;
  item?: any;
  initialValues?: Record<string, any>;
  parentTabId?: string;
}

/**
 * Tab manager state
 */
interface TabManagerState {
  tabs: DataTabState[];
  activeTabIndex: number;
  /**
   * Array of tabs contributing to the global filter. Multiple tabs can be sources simultaneously,
   * and their filters are combined using AND logic through configured global filter mappings.
   */
  globalFilterSources: Array<{ sourceTabId: string; item: any }>;
  /**
   * Tab IDs that the user has requested as filter sources but don't yet have a selected row.
   * Once a tab reports a selection via `UPDATE_TAB_SELECTION`, it's promoted to globalFilterSources.
   */
  pendingGlobalFilterTabIds: string[];
  tabSelections: Record<string, any>;
  /**
   * Version counter per list tab. Incrementing triggers DataList to reload data.
   */
  listVersions: Record<string, number>;
}

/**
 * Actions for the tab reducer
 */
type TabAction =
  | { type: 'ADD_LIST_TAB'; payload: { configKey: string; title: string } }
  | {
    type: 'OPEN_DETAIL_TAB';
    payload: { item: any; configKey: string; parentTabId: string; replace: boolean; title: string };
  }
  | {
    type: 'OPEN_CREATE_TAB';
    payload: { configKey: string; parentTabId: string; title: string; initialValues?: Record<string, any> };
  }
  | {
    type: 'OPEN_EDIT_TAB';
    payload: { item: any; configKey: string; parentTabId: string; title: string };
  }
  | { type: 'REMOVE_TAB'; payload: { tabId: string } }
  | { type: 'SET_ACTIVE_TAB'; payload: { index: number } }
  | { type: 'TOGGLE_GLOBAL_FILTER'; payload: { tabId: string; additive: boolean } }
  | { type: 'SET_GLOBAL_FILTER_SOURCE'; payload: { tabId: string; item: any; additive: boolean } }
  | { type: 'UPDATE_TAB_SELECTION'; payload: { tabId: string; item: any | null } }
  | { type: 'INVALIDATE_LIST'; payload: { tabId: string } }
  | {
    /** Refresh open detail tabs showing a record that has just been saved. */
    type: 'REFRESH_TAB_ITEMS';
    payload: { configKey: string; item: any; title: string; matchesItem: (tabItem: any) => boolean };
  };

/**
 * Tab reducer for managing tab state
 */
function tabReducer(state: TabManagerState, action: TabAction): TabManagerState {
  switch (action.type) {
    case 'ADD_LIST_TAB': {
      const newTab: DataTabState = {
        id: generateRandomId(),
        type: 'list',
        title: action.payload.title,
        configKey: action.payload.configKey
      };
      return { ...state, tabs: [...state.tabs, newTab] };
    }

    case 'OPEN_DETAIL_TAB': {
      const { item, configKey, parentTabId, replace, title } = action.payload;
      const baseTabs = replace
        ? state.tabs.filter(t => !(t.type === 'detail' && t.parentTabId === parentTabId))
        : [...state.tabs];
      const parentIndex = baseTabs.findIndex(t => t.id === parentTabId);

      if (parentIndex === -1) return state;

      const detailTab: DataTabState = {
        id: generateRandomId(),
        type: 'detail',
        title,
        configKey,
        item,
        parentTabId
      };

      let insertIndex = parentIndex + 1;
      if (!replace) {
        const lastDetailIndex = baseTabs.reduce((lastIndex, tab, index) => {
          if (tab.type === 'detail' && tab.parentTabId === parentTabId) {
            return index;
          }
          return lastIndex;
        }, -1);
        if (lastDetailIndex > parentIndex) {
          insertIndex = lastDetailIndex + 1;
        }
      }

      const newTabs = [...baseTabs];
      newTabs.splice(insertIndex, 0, detailTab);

      return {
        ...state,
        tabs: newTabs,
        activeTabIndex: insertIndex
      };
    }

    case 'REMOVE_TAB': {
      const { tabId } = action.payload;
      const removedIndex = state.tabs.findIndex(t => t.id === tabId);

      if (removedIndex === -1) return state;

      const newTabs = state.tabs.filter(t => t.id !== tabId);
      let newActiveIndex = state.activeTabIndex;

      // Adjust active index if needed
      if (removedIndex === state.activeTabIndex) {
        // Removing active tab: switch to previous tab or first tab
        newActiveIndex = Math.max(0, removedIndex - 1);
      } else if (removedIndex < state.activeTabIndex) {
        // Removing tab before active: shift active index down
        newActiveIndex = state.activeTabIndex - 1;
      }

      return {
        ...state,
        tabs: newTabs,
        activeTabIndex: Math.min(newActiveIndex, newTabs.length - 1)
      };
    }

    case 'SET_ACTIVE_TAB': {
      return {
        ...state,
        activeTabIndex: action.payload.index
      };
    }

    case 'TOGGLE_GLOBAL_FILTER': {
      const { tabId, additive } = action.payload;
      const selectedItem = state.tabSelections[tabId];
      const isCurrentSource = state.globalFilterSources.some(s => s.sourceTabId === tabId);

      if (!additive) {
        // Regular double-click: toggle this tab as the only filter source
        // If already a source, remove it (clear filter)
        if (isCurrentSource) {
          return {
            ...state,
            pendingGlobalFilterTabIds: state.pendingGlobalFilterTabIds.filter(id => id !== tabId),
            globalFilterSources: state.globalFilterSources.filter(s => s.sourceTabId !== tabId)
          };
        }
        // Otherwise, replace all sources with this one
        return {
          ...state,
          pendingGlobalFilterTabIds: selectedItem ? [] : [tabId],
          globalFilterSources: selectedItem
            ? [{ sourceTabId: tabId, item: selectedItem }]
            : []
        };
      }

      // Ctrl+double-click: toggle this tab in/out of sources
      if (isCurrentSource) {
        // Remove from sources
        return {
          ...state,
          pendingGlobalFilterTabIds: state.pendingGlobalFilterTabIds.filter(id => id !== tabId),
          globalFilterSources: state.globalFilterSources.filter(s => s.sourceTabId !== tabId)
        };
      }

      // Add to sources
      if (!selectedItem) {
        // No selection yet - add to pending
        return {
          ...state,
          pendingGlobalFilterTabIds: [...state.pendingGlobalFilterTabIds, tabId]
        };
      }

      return {
        ...state,
        globalFilterSources: [...state.globalFilterSources, { sourceTabId: tabId, item: selectedItem }]
      };
    }

    case 'SET_GLOBAL_FILTER_SOURCE': {
      const { tabId, item, additive } = action.payload;
      const isCurrentSource = state.globalFilterSources.some(s => s.sourceTabId === tabId);

      const nextSelections = { ...state.tabSelections, [tabId]: item };
      const nextPending = state.pendingGlobalFilterTabIds.filter(id => id !== tabId);

      let nextSources: typeof state.globalFilterSources;

      if (!additive) {
        nextSources = [{ sourceTabId: tabId, item }];
      } else if (isCurrentSource) {
        nextSources = state.globalFilterSources.map(s =>
          s.sourceTabId === tabId ? { ...s, item } : s
        );
      } else {
        nextSources = [...state.globalFilterSources, { sourceTabId: tabId, item }];
      }

      return {
        ...state,
        tabSelections: nextSelections,
        pendingGlobalFilterTabIds: nextPending,
        globalFilterSources: nextSources
      };
    }

    case 'UPDATE_TAB_SELECTION': {
      const { tabId, item } = action.payload;
      const sourceIndex = state.globalFilterSources.findIndex(s => s.sourceTabId === tabId);
      const isCurrentSource = sourceIndex !== -1;
      const isPending = state.pendingGlobalFilterTabIds.includes(tabId);

      let nextSources = state.globalFilterSources;
      let nextPending = state.pendingGlobalFilterTabIds;

      if (item) {
        if (isCurrentSource) {
          // Update the item in the existing source entry
          nextSources = state.globalFilterSources.map((s, i) =>
            i === sourceIndex ? { ...s, item } : s
          );
        } else if (isPending) {
          // Promote from pending to active source
          nextSources = [...state.globalFilterSources, { sourceTabId: tabId, item }];
          nextPending = state.pendingGlobalFilterTabIds.filter(id => id !== tabId);
        }
      } else if (isCurrentSource) {
        // Selection cleared - move to pending so it can be re-activated
        nextSources = state.globalFilterSources.filter(s => s.sourceTabId !== tabId);
        nextPending = [...state.pendingGlobalFilterTabIds, tabId];
      }

      return {
        ...state,
        tabSelections: {
          ...state.tabSelections,
          [tabId]: item
        },
        pendingGlobalFilterTabIds: nextPending,
        globalFilterSources: nextSources
      };
    }

    case 'OPEN_CREATE_TAB': {
      const { configKey, parentTabId, title, initialValues } = action.payload;
      const parentIndex = state.tabs.findIndex(t => t.id === parentTabId);

      if (parentIndex === -1) return state;

      // Remove any existing create tab for this parent
      const baseTabs = state.tabs.filter(
        t => !(t.type === 'create' && t.parentTabId === parentTabId)
      );
      const adjustedParentIndex = baseTabs.findIndex(t => t.id === parentTabId);

      const createTab: DataTabState = {
        id: generateRandomId(),
        type: 'create',
        title,
        configKey,
        initialValues,
        parentTabId
      };

      // Insert after parent and any detail tabs
      let insertIndex = adjustedParentIndex + 1;
      const lastRelatedIndex = baseTabs.reduce((lastIndex, tab, index) => {
        if ((tab.type === 'detail' || tab.type === 'create') && tab.parentTabId === parentTabId) {
          return index;
        }
        return lastIndex;
      }, -1);
      if (lastRelatedIndex > adjustedParentIndex) {
        insertIndex = lastRelatedIndex + 1;
      }

      const newTabs = [...baseTabs];
      newTabs.splice(insertIndex, 0, createTab);

      return {
        ...state,
        tabs: newTabs,
        activeTabIndex: insertIndex
      };
    }

    case 'OPEN_EDIT_TAB': {
      const { item, configKey, parentTabId, title } = action.payload;
      const parentIndex = state.tabs.findIndex(t => t.id === parentTabId);

      if (parentIndex === -1) return state;

      // Remove any existing edit tab for this parent
      const baseTabs = state.tabs.filter(
        t => !(t.type === 'edit' && t.parentTabId === parentTabId)
      );
      const adjustedParentIndex = baseTabs.findIndex(t => t.id === parentTabId);

      const editTab: DataTabState = {
        id: generateRandomId(),
        type: 'edit',
        title,
        configKey,
        item,
        parentTabId
      };

      // Insert after parent and any detail/create tabs
      let insertIndex = adjustedParentIndex + 1;
      const lastRelatedIndex = baseTabs.reduce((lastIndex, tab, index) => {
        if ((tab.type === 'detail' || tab.type === 'create' || tab.type === 'edit') && tab.parentTabId === parentTabId) {
          return index;
        }
        return lastIndex;
      }, -1);
      if (lastRelatedIndex > adjustedParentIndex) {
        insertIndex = lastRelatedIndex + 1;
      }

      const newTabs = [...baseTabs];
      newTabs.splice(insertIndex, 0, editTab);

      return {
        ...state,
        tabs: newTabs,
        activeTabIndex: insertIndex
      };
    }

    case 'INVALIDATE_LIST': {
      const { tabId } = action.payload;
      return {
        ...state,
        listVersions: {
          ...state.listVersions,
          [tabId]: (state.listVersions[tabId] ?? 0) + 1
        }
      };
    }

    case 'REFRESH_TAB_ITEMS': {
      const { configKey, item, title, matchesItem } = action.payload;
      let changed = false;
      const tabs = state.tabs.map(tab => {
        if (tab.type === 'detail' && tab.configKey === configKey && tab.item && matchesItem(tab.item)) {
          changed = true;
          return { ...tab, item, title };
        }
        return tab;
      });
      return changed ? { ...state, tabs } : state;
    }

    default:
      return state;
  }
}

/**
 * Props for DataTabManager
 */
export interface DataTabManagerProps {
  config: Record<string, TabConfig>;
  defaultTabs?: string[];
  onActiveTabChange?: (tab: DataTabInfo | null) => void;
  onGlobalFilterChange?: (event: GlobalFilterChangeEvent) => void;
  onListQueryChange?: (snapshot: DataTabListQuerySnapshot) => void;
  itemReceiverPanel?: ItemReceiverPanelConfig;
  reloadKey?: number | string;
}

/**
 * DataTabManager component manages multiple tabs with data lists and detail views.
 * Features:
 * - Multiple list tabs with configurable data sources
 * - Auto-created detail tabs on item click
 * - Global filtering across tabs via double-click
 * - Tab counts and selection tracking
 */
export const DataTabManager: React.FC<DataTabManagerProps> = ({
  config,
  defaultTabs = [],
  onActiveTabChange,
  onGlobalFilterChange,
  onListQueryChange,
  itemReceiverPanel,
  reloadKey
}) => {
  const initialState: TabManagerState = {
    tabs: [],
    activeTabIndex: 0,
    globalFilterSources: [],
    pendingGlobalFilterTabIds: [],
    tabSelections: {},
    listVersions: {}
  };

  const [state, dispatch] = useReducer(tabReducer, initialState);
  const initialized = useRef(false);
  const lastActiveTabId = useRef<string | null>(null);
  const filterCacheRef = useRef<{
    filtersByTab: Record<string, Record<string, any> | undefined>;
    signaturesByTab: Record<string, string>;
  }>({
    filtersByTab: {},
    signaturesByTab: {}
  });
  /** Tracks whether each create/edit tab has unsaved changes. */
  const dirtyTabsRef = useRef<Set<string>>(new Set());
  /** Holds an action to run once the pending-close confirmation resolves (used when replacing a dirty create/edit tab). */
  const pendingReplaceActionRef = useRef<(() => void) | null>(null);
  /**
   * Per-config-key data revision counters. Bumped whenever a record of that tab is
   * created, edited, or deleted, so `useRelatedRecords` consumers refresh reactively.
   */
  const [dataVersions, setDataVersions] = useState<Record<string, number>>({});
  const bumpDataVersion = useCallback((configKey: string) => {
    setDataVersions((prev) => ({ ...prev, [configKey]: (prev[configKey] ?? 0) + 1 }));
  }, []);
  /**
   * Single point through which every successful create/edit/delete flows:
   * drops any caches behind the tab's dataSource (so the imminent list refetch
   * is genuinely fresh) and notifies reactive `useRelatedRecords` consumers.
   */
  const notifyRecordsChanged = useCallback((configKey: string) => {
    config[configKey]?.invalidateData?.();
    bumpDataVersion(configKey);
  }, [bumpDataVersion, config]);
  /**
   * Last-known query (merged filters, local filters, sort) per list tab. Kept here
   * because inactive list tabs unmount: it restores the user's sort/filters when a
   * tab remounts, and keys tab-count queries consistently with what each list shows.
   * `seedSignature` records the configured initial filters at capture time so a
   * parent-driven seed change (e.g. applying a filter preset) wins over restoration.
   */
  const [tabListQueries, setTabListQueries] = useState<Record<string, { query: DataListQuery; seedSignature: string }>>({});
  /** Checklist selections per list tab, restored across remounts. */
  const tabChecklistRef = useRef<Record<string, string[]>>({});
  /** State for the unsaved changes confirmation dialog. */
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  /**
   * Before opening a new create/edit tab for a parent, check whether that parent already
   * has a dirty create/edit tab open. If so, route through the same unsaved-changes
   * confirmation used for explicit tab close, and only run `openTab` once the user
   * confirms discarding it. Otherwise `openTab` runs immediately.
   */
  const requestChildTabReplace = useCallback((parentTabId: string, childType: 'create' | 'edit', openTab: () => void) => {
    // Only guard the tab type that will actually be replaced — a create tab and
    // an edit tab for the same parent coexist, so prompting about (or discarding)
    // the wrong one would still lose unsaved work silently.
    const dirtyChild = state.tabs.find(t => (
      t.type === childType
      && t.parentTabId === parentTabId
      && dirtyTabsRef.current.has(t.id)
    ));
    if (!dirtyChild) {
      openTab();
      return;
    }
    pendingReplaceActionRef.current = openTab;
    setPendingCloseTabId(dirtyChild.id);
  }, [state.tabs]);
  /** State for the list-row context menu managed by DataTabManager. */
  const [listContextMenu, setListContextMenu] = useState<{
    position: { x: number; y: number };
    tabId: string;
    configKey: string;
    item: any;
    index: number;
    additive: boolean;
  } | null>(null);
  // Per-tab requests to open an item-anchored fast-add draft in the tab's DataList.
  const [fastAddRequests, setFastAddRequests] = useState<Record<string, { item: any; token: number }>>({});
  const [isReceiverActive, setIsReceiverActive] = useState<boolean>(() => Boolean(itemReceiverPanel?.isActiveByDefault));
  const [splitRatio, setSplitRatio] = useState<number>(() => itemReceiverPanel?.splitDefault ?? 0.33);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileSplit, setIsMobileSplit] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
  const isMobileSplitRef = useRef(isMobileSplit);
  const queryClient = useQueryClient();
  const lastGlobalFilterSignature = useRef<string | null>(null);

  const applyReceiverActive = useCallback((active: boolean) => {
    setIsReceiverActive(active);
  }, []);

  useEffect(() => {
    isMobileSplitRef.current = isMobileSplit;
  }, [isMobileSplit]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobileSplit(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMobileMenuOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isMobileMenuOpen]);

  useEffect(() => {
    itemReceiverPanel?.onActiveChange?.(isReceiverActive);
  }, [itemReceiverPanel, isReceiverActive]);

  useEffect(() => {
    const ref = itemReceiverPanel?.setReceiverActiveRef;
    if (!ref) {
      return;
    }
    ref.current = (active: boolean) => {
      applyReceiverActive(active);
    };
    return () => {
      ref.current = null;
    };
  }, [itemReceiverPanel?.setReceiverActiveRef, applyReceiverActive]);

  /**
   * Initialize tabs from defaultTabs prop
   */
  useEffect(() => {
    if (!initialized.current && defaultTabs.length > 0) {
      defaultTabs.forEach(configKey => {
        const tabConfig = config[configKey];
        if (tabConfig) {
          dispatch({
            type: 'ADD_LIST_TAB',
            payload: {
              configKey,
              title: resolveListTabTitle(configKey, tabConfig)
            }
          });
        }
      });
      initialized.current = true;
    }
  }, [defaultTabs, config]);

  /**
   * Notify consumers when the active tab changes.
   */
  useEffect(() => {
    if (!onActiveTabChange) {
      return;
    }
    const activeTab = state.tabs[state.activeTabIndex];
    if (!activeTab) {
      if (lastActiveTabId.current !== null) {
        lastActiveTabId.current = null;
        onActiveTabChange(null);
      }
      return;
    }
    if (lastActiveTabId.current !== activeTab.id) {
      lastActiveTabId.current = activeTab.id;
      onActiveTabChange({
        id: activeTab.id,
        type: activeTab.type,
        title: activeTab.title,
        configKey: activeTab.configKey
      });
    }
  }, [onActiveTabChange, state.activeTabIndex, state.tabs]);

  /**
   * Handle tab click
   */
  const handleTabClick = useCallback((index: number) => {
    dispatch({ type: 'SET_ACTIVE_TAB', payload: { index } });
  }, []);

  /**
   * Handle shift+click on a DataList row.
   * Dispatches SET_GLOBAL_FILTER_SOURCE (replace by default, additive with Ctrl/Cmd).
   */
  const handleShiftClick = useCallback((tabId: string) => {
    return (item: any, _index: number, event: React.MouseEvent) => {
      dispatch({
        type: 'SET_GLOBAL_FILTER_SOURCE',
        payload: { tabId, item, additive: event.ctrlKey || event.metaKey }
      });
    };
  }, []);

  /**
   * Handle right-click on a DataList row.
   * Opens a DataTabManager-managed context menu combining tab-specific options
   * with the built-in global filter option.
   */
  const handleListContextMenu = useCallback((tabId: string, configKey: string) => {
    return (item: any, index: number, event: React.MouseEvent) => {
      setListContextMenu({
        position: { x: event.clientX, y: event.clientY },
        tabId,
        configKey,
        item,
        index,
        additive: event.ctrlKey || event.metaKey
      });
    };
  }, []);

  /**
   * Combined context menu options: tab-specific options + global filter toggle.
   */
  const listContextMenuOptions = useMemo(() => {
    if (!listContextMenu) return [];
    const { tabId, configKey, item, index, additive } = listContextMenu;
    const tabConfig = config[configKey];
    const closeMenu = () => setListContextMenu(null);
    const openCreateTab = (options?: { title?: string; initialValues?: Record<string, any> }) => {
      if (!tabConfig || !(tabConfig.createComponent || (tabConfig.schema && tabConfig.onUpsert))) {
        return;
      }
      requestChildTabReplace(tabId, 'create', () => dispatch({
        type: 'OPEN_CREATE_TAB',
        payload: {
          configKey,
          parentTabId: tabId,
          title: options?.title ?? resolveCreateTabTitle(configKey, tabConfig),
          initialValues: options?.initialValues
        }
      }));
      closeMenu();
    };
    const openDetailTab = () => {
      if (!tabConfig?.detailComponent) {
        return;
      }
      dispatch({
        type: 'OPEN_DETAIL_TAB',
        payload: {
          item,
          configKey,
          parentTabId: tabId,
          replace: true,
          title: `Detail: ${resolveItemTitle(item, tabConfig)}`
        }
      });
      closeMenu();
    };
    const deleteItem = tabConfig?.onDelete
      ? async () => {
          closeMenu();
          const deleted = await tabConfig.onDelete!(item);
          if (deleted) {
            notifyRecordsChanged(configKey);
            dispatch({ type: 'INVALIDATE_LIST', payload: { tabId } });
            queryClient.invalidateQueries({ queryKey: ['tab-counts'] });
          }
        }
      : undefined;
    const openFastAddForItem = tabConfig?.fastAdd?.createDraftForItem
      ? () => {
          setFastAddRequests((prev) => ({
            ...prev,
            [tabId]: { item, token: (prev[tabId]?.token ?? 0) + 1 }
          }));
          closeMenu();
        }
      : undefined;
    const tabOptions = tabConfig?.getContextMenuOptions?.(item, index, { closeMenu, openCreateTab, openDetailTab, deleteItem, openFastAddForItem }) ?? [];
    const isSource = state.globalFilterSources.some(s => s.sourceTabId === tabId);

    const filterOption = {
      label: isSource ? 'Remove global filter' : 'Make global filter',
      onClick: () => {
        if (isSource) {
          dispatch({
            type: 'TOGGLE_GLOBAL_FILTER',
            payload: { tabId, additive }
          });
        } else {
          dispatch({
            type: 'SET_GLOBAL_FILTER_SOURCE',
            payload: { tabId, item, additive }
          });
        }
        setListContextMenu(null);
      }
    };

    return [...tabOptions, filterOption];
  }, [config, listContextMenu, notifyRecordsChanged, queryClient, state.globalFilterSources, requestChildTabReplace, resolveItemTitle]);

  /**
   * Handle tab close - checks for unsaved changes before closing
   */
  const handleTabClose = useCallback((tabId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const tab = state.tabs.find(t => t.id === tabId);
    const isFormTab = tab?.type === 'create' || tab?.type === 'edit';

    if (isFormTab && dirtyTabsRef.current.has(tabId)) {
      setPendingCloseTabId(tabId);
      return;
    }

    dirtyTabsRef.current.delete(tabId);
    dispatch({ type: 'REMOVE_TAB', payload: { tabId } });
  }, [state.tabs]);

  /**
   * Confirm closing a dirty tab - discard unsaved changes.
   * If this confirmation was triggered by an attempt to open a replacement
   * create/edit tab (`requestChildTabReplace`), run that action now that the
   * dirty tab has been discarded.
   */
  const handleConfirmClose = useCallback(() => {
    if (pendingCloseTabId) {
      dirtyTabsRef.current.delete(pendingCloseTabId);
      dispatch({ type: 'REMOVE_TAB', payload: { tabId: pendingCloseTabId } });
      setPendingCloseTabId(null);
      const pendingReplace = pendingReplaceActionRef.current;
      pendingReplaceActionRef.current = null;
      pendingReplace?.();
    }
  }, [pendingCloseTabId]);

  /**
   * Cancel closing a dirty tab - keep the tab open.
   * Discards any pending replacement action (e.g. a blocked "+" / double-click open).
   */
  const handleCancelClose = useCallback(() => {
    pendingReplaceActionRef.current = null;
    setPendingCloseTabId(null);
  }, []);

  /**
   * Create a dirty state change handler for a specific tab
   */
  const createDirtyChangeHandler = useCallback((tabId: string) => {
    return (isDirty: boolean) => {
      if (isDirty) {
        dirtyTabsRef.current.add(tabId);
      } else {
        dirtyTabsRef.current.delete(tabId);
      }
    };
  }, []);

  /**
   * Handle item double-click in a list.
   * Opens the edit form directly when the tab supports editing,
   * otherwise falls back to the read-only detail view.
   */
  const handleItemDoubleClick = useCallback((tabId: string, configKey: string) => {
    return (item: any, _index: number, _event: React.MouseEvent) => {
      const tabConfig = config[configKey];
      if ((tabConfig?.openDetailOnDoubleClick ?? true) === false) {
        return;
      }
      const canEdit = Boolean(tabConfig?.onUpsert && tabConfig?.schema);

      if (canEdit) {
        const editAccess = tabConfig?.getEditAccess?.(item);
        const isAllowed = typeof editAccess === 'boolean'
          ? editAccess
          : (editAccess?.allowed ?? true);
        const deniedMessage = typeof editAccess === 'object'
          ? editAccess.message
          : undefined;
        if (!isAllowed) {
          if (deniedMessage) {
            window.alert(deniedMessage);
          }
          return;
        }
        const itemName = resolveItemTitle(item, tabConfig);
        requestChildTabReplace(tabId, 'edit', () => dispatch({
          type: 'OPEN_EDIT_TAB',
          payload: {
            item,
            configKey,
            parentTabId: tabId,
            title: `Edit: ${itemName}`
          }
        }));
      } else {
        // Always replace the existing detail tab. (A shift-modified variant that
        // opened an additional tab was unreachable: shift+click is consumed by
        // the global-filter gesture before double-click detection.)
        dispatch({
          type: 'OPEN_DETAIL_TAB',
          payload: {
            item,
            configKey,
            parentTabId: tabId,
            replace: true,
            title: `Detail: ${resolveItemTitle(item, tabConfig)}`
          }
        });
      }
    };
  }, [config, resolveItemTitle, requestChildTabReplace]);

  /**
   * Handle selection change in a list
   */
  const handleSelectionChange = useCallback((tabId: string, configKey: string) => {
    return (item: any | null) => {
      const tabConfig = config[configKey];
      const currentItem = state.tabSelections[tabId] ?? null;
      const getItemId = tabConfig?.getItemId;
      const notifyOnReselect = Boolean(tabConfig?.notifyOnReselect);
      if (getItemId) {
        const currentId = currentItem ? getItemId(currentItem) : null;
        const nextId = item ? getItemId(item) : null;
        if (currentId === nextId) {
          const didRefreshSelectedItem = currentItem !== item;
          if (didRefreshSelectedItem) {
            dispatch({
              type: 'UPDATE_TAB_SELECTION',
              payload: { tabId, item }
            });
          }
          if (didRefreshSelectedItem || notifyOnReselect) {
            tabConfig?.onSelectionChange?.(item);
          }
          return;
        }
      }
      dispatch({
        type: 'UPDATE_TAB_SELECTION',
        payload: { tabId, item }
      });
      tabConfig?.onSelectionChange?.(item);
    };
  }, [config, state.tabSelections]);

  const visibleConfigKeys = useMemo(() => {
    if (!itemReceiverPanel) {
      return null;
    }
    const keys = isReceiverActive
      ? itemReceiverPanel.visibleTabConfigKeysWhenActive
      : itemReceiverPanel.visibleTabConfigKeysWhenInactive;
    if (!keys || keys.length === 0) {
      return null;
    }
    return new Set(keys);
  }, [isReceiverActive, itemReceiverPanel]);

  const visibleTabIndices = useMemo(() => {
    return state.tabs.reduce<number[]>((indices, tab, index) => {
      if (!visibleConfigKeys || visibleConfigKeys.has(tab.configKey)) {
        indices.push(index);
      }
      return indices;
    }, []);
  }, [state.tabs, visibleConfigKeys]);

  const visibleTabIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const index of visibleTabIndices) {
      const tab = state.tabs[index];
      if (tab) {
        ids.add(tab.id);
      }
    }
    return ids;
  }, [state.tabs, visibleTabIndices]);

  const effectiveGlobalFilterSources = useMemo(() => {
    return state.globalFilterSources.filter((source) => visibleTabIdSet.has(source.sourceTabId));
  }, [state.globalFilterSources, visibleTabIdSet]);

  const globalFilterChangeEvent = useMemo<GlobalFilterChangeEvent>(() => {
    const filter: Record<string, unknown> = {};
    const sources = effectiveGlobalFilterSources.map((source) => {
      const sourceTab = state.tabs.find((tab) => tab.id === source.sourceTabId);
      const sourceConfigKey = sourceTab?.configKey ?? '';
      const tabConfig = sourceConfigKey ? config[sourceConfigKey] : undefined;
      const selectedItem = state.tabSelections[source.sourceTabId] ?? source.item;
      const contribution = tabConfig
        ? mapRecordToGlobalFilter(selectedItem, tabConfig.globalFilterSets ?? tabConfig.globalFilterFieldMap)
        : undefined;

      if (contribution) {
        Object.assign(filter, contribution);
      }

      return {
        sourceTabId: source.sourceTabId,
        sourceConfigKey,
        sourceTabTitle: sourceTab?.title ?? '',
        item: selectedItem,
        valueLabel: tabConfig ? resolveItemTitle(selectedItem, tabConfig) : '',
        contribution
      };
    });

    return {
      filter,
      sources,
      valueLabel: sources
        .map((source) => source.valueLabel)
        .filter((label) => label.length > 0)
        .join(' + ')
    };
  }, [config, effectiveGlobalFilterSources, state.tabSelections, state.tabs]);

  useEffect(() => {
    if (!onGlobalFilterChange) {
      return;
    }

    const signature = stableSerialize({
      filter: globalFilterChangeEvent.filter,
      sources: globalFilterChangeEvent.sources.map((source) => ({
        sourceTabId: source.sourceTabId,
        valueLabel: source.valueLabel
      }))
    });

    if (lastGlobalFilterSignature.current === signature) {
      return;
    }

    lastGlobalFilterSignature.current = signature;
    onGlobalFilterChange(globalFilterChangeEvent);
  }, [globalFilterChangeEvent, onGlobalFilterChange]);

  useEffect(() => {
    if (state.tabs.length === 0 || visibleTabIndices.length === 0) {
      return;
    }
    if (!visibleTabIndices.includes(state.activeTabIndex)) {
      dispatch({
        type: 'SET_ACTIVE_TAB',
        payload: { index: visibleTabIndices[0] }
      });
    }
  }, [state.activeTabIndex, state.tabs.length, visibleTabIndices]);

  const clampSplitRatio = useCallback((nextRatio: number, totalWidth: number): number => {
    const minLeftPx = itemReceiverPanel?.minLeftPx ?? 280;
    const minRightPx = itemReceiverPanel?.minRightPx ?? 420;
    return clampSplitRatioForWidth(nextRatio, totalWidth, {
      minLeftPx,
      minRightPx
    });
  }, [itemReceiverPanel?.minLeftPx, itemReceiverPanel?.minRightPx]);

  const updateSplitFromClientX = useCallback((clientX: number) => {
    const container = splitContainerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const rawRatio = (clientX - rect.left) / rect.width;
    setSplitRatio(clampSplitRatio(rawRatio, rect.width));
  }, [clampSplitRatio]);

  useEffect(() => {
    if (!itemReceiverPanel) {
      return;
    }
    const width = splitContainerRef.current?.getBoundingClientRect().width ?? 1200;
    setSplitRatio((current) => clampSplitRatio(current, width));
  }, [clampSplitRatio, isReceiverActive, itemReceiverPanel]);

  useEffect(() => {
    const ref = itemReceiverPanel?.setRightPaneWidthPxRef;
    if (!ref) return;
    ref.current = (desiredRightPx: number) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const totalWidth = container.getBoundingClientRect().width;
      if (totalWidth <= 0) return;
      const splitterEl = container.querySelector('.data-tab-splitter') as HTMLElement | null;
      const splitterWidth = splitterEl?.offsetWidth ?? 8;
      const rawRatio = 1 - (desiredRightPx + splitterWidth) / totalWidth;
      setSplitRatio(clampSplitRatio(rawRatio, totalWidth));
    };
    return () => { ref.current = null; };
  }, [itemReceiverPanel?.setRightPaneWidthPxRef, clampSplitRatio]);

  const handleSplitterMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateSplitFromClientX(moveEvent.clientX);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [updateSplitFromClientX]);

  const updateSplitFromClientY = useCallback((clientY: number) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) return;
    const rawRatio = (clientY - rect.top) / rect.height;
    setSplitRatio(Math.min(0.85, Math.max(0.15, rawRatio)));
  }, []);

  const handleSplitterTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    event.preventDefault();

    const handleTouchMove = (moveEvent: TouchEvent) => {
      const touch = moveEvent.touches[0];
      if (!touch) return;
      if (isMobileSplitRef.current) {
        updateSplitFromClientY(touch.clientY);
      } else {
        updateSplitFromClientX(touch.clientX);
      }
    };

    const handleTouchEnd = () => {
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };

    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
  }, [updateSplitFromClientX, updateSplitFromClientY]);

  const globalFiltersByTab = useMemo(() => {
    const hasSources = globalFilterChangeEvent.sources.length > 0;
    const sourceContexts = globalFilterChangeEvent.sources.map((source) => ({
      sourceItem: source.item,
      sourceConfigKey: source.sourceConfigKey,
      sourceTabId: source.sourceTabId
    }));

    const byTab: Record<string, Record<string, any> | undefined> = {};
    const signatureByTab: Record<string, string> = {};
    const sourceTabIds = new Set(sourceContexts.map(s => s.sourceTabId));
    const cached = filterCacheRef.current;

    for (const tab of state.tabs) {
      if (tab.type !== 'list') {
        continue;
      }
      const tabConfig = config[tab.configKey];
      if (!tabConfig) {
        continue;
      }

      let nextFilter: Record<string, any> | undefined;

      if (!hasSources) {
        nextFilter = undefined;
      } else if (sourceTabIds.has(tab.id)) {
        // Source tab: keep only the scoping contributed by the OTHER active
        // sources. The tab's own contribution must never feed back into its own
        // list — selecting a row on the filter-owning tab would otherwise
        // refilter that list and reload it (losing scroll position) on every click.
        const otherSourcesGlobal: Record<string, unknown> = {};
        for (const source of globalFilterChangeEvent.sources) {
          if (source.sourceTabId !== tab.id && source.contribution) {
            Object.assign(otherSourcesGlobal, source.contribution);
          }
        }
        const receivedFromOthers = Object.keys(otherSourcesGlobal).length > 0
          ? (tabConfig.globalFilterReceives
            ? mapReceivedGlobalFilterToLocal(otherSourcesGlobal, tabConfig.globalFilterReceives)
            : mapGlobalFilterToLocal(otherSourcesGlobal, tabConfig.globalFilterFieldMap))
          : undefined;
        nextFilter = receivedFromOthers && Object.keys(receivedFromOthers).length > 0
          ? receivedFromOthers
          : undefined;
      } else {
        // Try custom buildGlobalFilter first (for complex cases)
        // Pass the primary source fields for backwards compatibility and all sources for additive logic.
        const primarySource = sourceContexts[0];
        const mapped = tabConfig.buildGlobalFilter?.({
          sourceItem: primarySource?.sourceItem,
          sourceConfigKey: primarySource?.sourceConfigKey ?? '',
          sourceTabId: primarySource?.sourceTabId ?? '',
          sources: sourceContexts
        });

        if (mapped === null) {
          nextFilter = undefined;
        } else if (mapped !== undefined) {
          nextFilter = mapped;
        } else {
          // Default: use explicit receive maps, falling back to the legacy bidirectional map.
          nextFilter = tabConfig.globalFilterReceives
            ? mapReceivedGlobalFilterToLocal(globalFilterChangeEvent.filter, tabConfig.globalFilterReceives)
            : mapGlobalFilterToLocal(globalFilterChangeEvent.filter, tabConfig.globalFilterFieldMap);
        }
      }

      const signature = stableSerialize(nextFilter ?? {});
      signatureByTab[tab.id] = signature;

      if (cached.signaturesByTab[tab.id] === signature) {
        byTab[tab.id] = cached.filtersByTab[tab.id];
      } else {
        byTab[tab.id] = nextFilter ?? undefined;
      }
    }

    filterCacheRef.current = {
      filtersByTab: byTab,
      signaturesByTab: signatureByTab
    };

    return byTab;
  }, [config, globalFilterChangeEvent, state.tabs]);

  /**
   * The filters a tab's list is (or would be) using: its persisted local filters
   * (when still valid for the currently configured seed), otherwise the seed,
   * merged with the current global filter. Count queries and count writes share
   * this construction so the tab badge always reflects what the list shows.
   */
  const getEffectiveTabFilters = useCallback((tabId: string, configKey: string): Record<string, any> => {
    const tabConfig = config[configKey];
    const seed = tabConfig?.filterConfig?.initialFilters ?? {};
    const remembered = tabListQueries[tabId];
    const localFilters = remembered && remembered.seedSignature === stableSerialize(seed)
      ? (remembered.query.localFilters ?? seed)
      : seed;
    return { ...localFilters, ...(globalFiltersByTab[tabId] ?? {}) };
  }, [config, globalFiltersByTab, tabListQueries]);

  /**
   * Handle total count change
   */
  const getTotalChangeHandler = useCallback((tabId: string, configKey: string) => {
    return (total: number) => {
      const filterSig = stableSerialize(getEffectiveTabFilters(tabId, configKey));
      queryClient.setQueryData(['tab-counts', configKey, filterSig], total);
    };
  }, [getEffectiveTabFilters, queryClient]);

  /**
   * Handle add button click in a list
   */
  const handleAddClick = useCallback((tabId: string, configKey: string) => {
    return () => {
      const tabConfig = config[configKey];
      if (!tabConfig) return;
      requestChildTabReplace(tabId, 'create', () => dispatch({
        type: 'OPEN_CREATE_TAB',
        payload: {
          configKey,
          parentTabId: tabId,
          title: resolveCreateTabTitle(configKey, tabConfig)
        }
      }));
    };
  }, [config, requestChildTabReplace]);

  /**
   * Hand hosts the per-config external actions (TabConfig.registerTabActions).
   * Re-registered whenever tab state changes so the actions always target the
   * config's current list tab.
   */
  useEffect(() => {
    const entries = Object.entries(config).filter(([, tabConfig]) => tabConfig.registerTabActions);
    if (entries.length === 0) {
      return;
    }
    for (const [configKey, tabConfig] of entries) {
      tabConfig.registerTabActions!({
        openCreateTab: (options) => {
          if (!(tabConfig.createComponent || (tabConfig.schema && tabConfig.onUpsert))) {
            return false;
          }
          const listTab = state.tabs.find(t => t.type === 'list' && t.configKey === configKey);
          if (!listTab) {
            return false;
          }
          requestChildTabReplace(listTab.id, 'create', () => dispatch({
            type: 'OPEN_CREATE_TAB',
            payload: {
              configKey,
              parentTabId: listTab.id,
              title: options?.title ?? resolveCreateTabTitle(configKey, tabConfig),
              initialValues: options?.initialValues
            }
          }));
          return true;
        }
      });
    }
    return () => {
      for (const [, tabConfig] of entries) {
        tabConfig.registerTabActions!(null);
      }
    };
  }, [config, requestChildTabReplace, state.tabs]);

  /**
   * Handle create form submission
   */
  const handleCreateSubmit = useCallback((tab: DataTabState) => {
    return async (data: Record<string, any>): Promise<boolean> => {
      const tabConfig = config[tab.configKey];
      if (!tabConfig?.onUpsert) {
        console.error('No onUpsert handler configured for', tab.configKey);
        return false;
      }

      try {
        const newItem = await tabConfig.onUpsert(data);
        if (!newItem) {
          return false;
        }

        // Clear dirty state before closing
        dirtyTabsRef.current.delete(tab.id);

        // Close the create tab
        dispatch({ type: 'REMOVE_TAB', payload: { tabId: tab.id } });

        // Notify reactive consumers that this tab's records changed
        notifyRecordsChanged(tab.configKey);

        // Invalidate the parent list to trigger refresh
        if (tab.parentTabId) {
          dispatch({ type: 'INVALIDATE_LIST', payload: { tabId: tab.parentTabId } });
          queryClient.invalidateQueries({ queryKey: ['tab-counts'] });
        }

        return true;
      } catch (err) {
        console.error('Error creating record:', err);
        window.alert(`Failed to save: ${err instanceof Error ? err.message : 'Unexpected error.'}`);
        return false;
      }
    };
  }, [config, queryClient, notifyRecordsChanged]);

  /**
   * Handle cancel/close of create form - checks for unsaved changes
   */
  const handleCreateCancel = useCallback((tabId: string) => {
    return () => {
      if (dirtyTabsRef.current.has(tabId)) {
        setPendingCloseTabId(tabId);
        return;
      }
      dirtyTabsRef.current.delete(tabId);
      dispatch({ type: 'REMOVE_TAB', payload: { tabId } });
    };
  }, []);

  /**
   * Handle edit form submission
   */
  const handleEditSubmit = useCallback((tab: DataTabState) => {
    return async (data: Record<string, any>): Promise<boolean> => {
      const tabConfig = config[tab.configKey];
      if (!tabConfig?.onUpsert || !tab.item) {
        console.error('No onUpsert handler configured for', tab.configKey);
        return false;
      }

      try {
        const updatedItem = await tabConfig.onUpsert(data, tab.item);
        if (!updatedItem) {
          return false;
        }

        // Clear dirty state before closing
        dirtyTabsRef.current.delete(tab.id);

        // Close the edit tab
        dispatch({ type: 'REMOVE_TAB', payload: { tabId: tab.id } });

        // Notify reactive consumers that this tab's records changed
        notifyRecordsChanged(tab.configKey);

        // Refresh any open detail tab still showing the pre-edit record
        if (typeof updatedItem === 'object') {
          const getItemId = tabConfig.getItemId;
          let updatedId: string | null = null;
          try {
            updatedId = getItemId(updatedItem);
          } catch {
            updatedId = null;
          }
          if (updatedId !== null) {
            dispatch({
              type: 'REFRESH_TAB_ITEMS',
              payload: {
                configKey: tab.configKey,
                item: updatedItem,
                title: `Detail: ${resolveItemTitle(updatedItem, tabConfig)}`,
                matchesItem: (tabItem: any) => {
                  try {
                    return getItemId(tabItem) === updatedId;
                  } catch {
                    return false;
                  }
                }
              }
            });
          }
        }

        // Invalidate the parent list to trigger refresh
        if (tab.parentTabId) {
          dispatch({ type: 'INVALIDATE_LIST', payload: { tabId: tab.parentTabId } });
          queryClient.invalidateQueries({ queryKey: ['tab-counts'] });
        }

        return true;
      } catch (err) {
        console.error('Error updating record:', err);
        window.alert(`Failed to save: ${err instanceof Error ? err.message : 'Unexpected error.'}`);
        return false;
      }
    };
  }, [config, queryClient, notifyRecordsChanged, resolveItemTitle]);

  /**
   * Handle cancel/close of edit form - checks for unsaved changes
   */
  const handleEditCancel = useCallback((tabId: string) => {
    return () => {
      if (dirtyTabsRef.current.has(tabId)) {
        setPendingCloseTabId(tabId);
        return;
      }
      dirtyTabsRef.current.delete(tabId);
      dispatch({ type: 'REMOVE_TAB', payload: { tabId } });
    };
  }, []);

  /**
   * Resolve a record title from explicit tab configuration.
   */
  function resolveItemTitle(item: unknown, tabConfig: TabConfig): string {
    if (!item || typeof item !== 'object') {
      return 'Item';
    }
    const record = item as Record<string, unknown>;

    if (tabConfig.getItemTitle) {
      const explicitTitle = tabConfig.getItemTitle(item);
      if (explicitTitle.trim()) {
        return explicitTitle.trim();
      }
    }

    if (tabConfig.titleField) {
      const raw = (item as Record<string, unknown>)[String(tabConfig.titleField)];
      if (raw !== null && raw !== undefined) {
        const title = typeof raw === 'string' ? raw.trim() : String(raw);
        if (title) {
          return title;
        }
      }
    }

    for (const fallbackField of ['title', 'name']) {
      const raw = record[fallbackField];
      if (raw !== null && raw !== undefined) {
        const title = typeof raw === 'string' ? raw.trim() : String(raw);
        if (title) {
          return title;
        }
      }
    }

    const itemId = tabConfig.getItemId(item);
    return itemId || 'Item';
  }


  /**
   * Get tab title without count.
   */
  const getTabTitle = useCallback((tab: DataTabState) => {
    return tab.title;
  }, []);

  /**
   * Returns the stable, human-readable label for a tab that should be used for accessibility / automation.
   * This intentionally excludes dynamic counts so automated clicks can reliably match by name.
   */
  const getTabAriaLabel = useCallback((tab: DataTabState) => {
    return tab.title;
  }, []);

  /**
   * Stable tab test-id used by browser automation flows.
   */
  const getTabTestId = useCallback((tab: DataTabState) => {
    const configToken = toTestIdToken(tab.configKey || tab.title || tab.id || 'tab');
    if (tab.type === 'list') {
      return `data-tab-${configToken}`;
    }
    return `data-tab-${tab.type}-${configToken}`;
  }, []);

  /**
   * Fetch related records from another tab for use in dropdown fields.
   * Always fetches the full unfiltered record set for that tab, projected to the
   * requested fields — dropdown pickers should not silently narrow because an
   * unrelated tab happens to be the current global filter source.
   */
  const fetchRelatedRecords = useCallback(
    async (tabName: string, fields: string[]): Promise<Record<string, any>[]> => {
      const tabConfig = config[tabName];
      if (!tabConfig) {
        console.warn(`fetchRelatedRecords: Unknown tab "${tabName}"`);
        return [];
      }

      const result = await tabConfig.dataSource({
        from: 0,
        size: 1000,
        filters: {}
      });

      // Project to requested fields only
      return result.items.map(item => {
        const projected: Record<string, any> = {};
        for (const field of fields) {
          if (field in (item as object)) {
            projected[field] = (item as Record<string, any>)[field];
          }
        }
        return projected;
      });
    },
    [config]
  );

  const relatedRecordsContextValue = useMemo<RelatedRecordsContextValue>(
    () => ({
      fetchRelatedRecords,
      hasTab: (tabName: string) => Boolean(config[tabName]),
      dataVersions
    }),
    [fetchRelatedRecords, config, dataVersions]
  );

  /**
   * Stable list of list-type tabs for count queries.
   */
  const listTabs = useMemo(
    () => state.tabs.filter((tab) => tab.type === 'list'),
    [state.tabs]
  );

  /**
   * Prefetch list-tab totals using React Query.
   *
   * Query keys encode the configKey and serialized filter values, so counts only refetch
   * when the actual global filter changes — not when unrelated config properties
   * (pricingPins, clientOrgOptions, etc.) cause the config object to be recreated.
   *
   * After record create/edit/delete, call queryClient.invalidateQueries({ queryKey: ['tab-counts'] })
   * to trigger a refresh.
   */
  const tabCountQueries = useQueries({
    queries: listTabs.map((tab) => {
      const tabConfig = config[tab.configKey];
      const filters = getEffectiveTabFilters(tab.id, tab.configKey);
      const filterSig = stableSerialize(filters);
      return {
        queryKey: ['tab-counts', tab.configKey, filterSig],
        queryFn: async (): Promise<number> => {
          if (!tabConfig) return 0;
          const response = await tabConfig.dataSource({ from: 0, size: 1, filters });
          return response.total ?? 0;
        },
        staleTime: 60_000,
        enabled: !!tabConfig,
      };
    }),
  });

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    listTabs.forEach((tab, i) => {
      const data = tabCountQueries[i]?.data;
      if (data !== undefined) {
        counts[tab.id] = data;
      }
    });
    return counts;
  }, [listTabs, tabCountQueries]);

  /**
   * Get tab count from React Query results.
   */
  const getTabCount = useCallback((tab: DataTabState) => {
    if (tab.type === 'list' && tabCounts[tab.id] !== undefined) {
      return tabCounts[tab.id].toLocaleString();
    }
    return null;
  }, [tabCounts]);

  /**
   * Render tab content
   */
  const renderTabContent = useCallback((tab: DataTabState) => {
    const tabConfig = config[tab.configKey];
    if (!tabConfig) return null;

    if (tab.type === 'list') {
      const selectedItem = state.tabSelections[tab.id] ?? null;
      // A schema alone renders a create form, but saving needs onUpsert — without
      // it the form would be a dead end, so don't offer the add button.
      const canCreate = Boolean(tabConfig.createComponent || (tabConfig.schema && tabConfig.onUpsert));
      const listClassName = [
        isReceiverActive ? (itemReceiverPanel?.leftPaneDataListClassNameWhenActive ?? '') : '',
        tabConfig.dataListClassName ?? ''
      ].filter(Boolean).join(' ');
      const shouldShowAddButton = canCreate && !(itemReceiverPanel && isReceiverActive);
      const seedSignature = stableSerialize(tabConfig.filterConfig?.initialFilters ?? {});
      const rememberedQuery = tabListQueries[tab.id];
      const restoredChecks = tabChecklistRef.current[tab.id];
      const restoredState = rememberedQuery || restoredChecks?.length
        ? {
            sort: rememberedQuery ? (rememberedQuery.query.sort ?? null) : undefined,
            localFilters: rememberedQuery && rememberedQuery.seedSignature === seedSignature
              ? rememberedQuery.query.localFilters
              : undefined,
            checkedIds: restoredChecks
          }
        : undefined;
      const handleQueryChange = (query: DataListQuery) => {
        setTabListQueries(prev => {
          const existing = prev[tab.id];
          if (
            existing
            && existing.seedSignature === seedSignature
            && stableSerialize(existing.query) === stableSerialize(query)
          ) {
            return prev;
          }
          return { ...prev, [tab.id]: { query, seedSignature } };
        });
        tabConfig.onQueryChange?.(query);
        onListQueryChange?.({
          tabKey: tab.configKey,
          query,
          dataSource: tabConfig.dataSource as (params: DataSourceParams) => Promise<DataSourceResult<unknown>>
        });
      };
      return (
        <DataList
          dataSource={tabConfig.dataSource}
          columns={tabConfig.columns}
          getItemId={tabConfig.getItemId}
          onItemDoubleClick={handleItemDoubleClick(tab.id, tab.configKey)}
          onItemContextMenu={handleListContextMenu(tab.id, tab.configKey)}
          onShiftClick={handleShiftClick(tab.id)}
          onSelectionChange={handleSelectionChange(tab.id, tab.configKey)}
          onTotalChange={getTotalChangeHandler(tab.id, tab.configKey)}
          onChecklist={tabConfig.onChecklist}
          getOtherChecks={tabConfig.getOtherChecks}
          getChecklistMarkerColor={tabConfig.getChecklistMarkerColor}
          getChecklistMarkerStatus={tabConfig.getChecklistMarkerStatus}
          getEditAccess={tabConfig.getEditAccess}
          tabName={tab.configKey}
          checklistResetKey={tabConfig.checklistResetKey}
          restoredState={restoredState}
          onLocalChecksChange={tabConfig.onChecklist
            ? (checkedIds) => { tabChecklistRef.current[tab.id] = checkedIds; }
            : undefined}
          notifyOnReselect={Boolean(tabConfig.notifyOnReselect)}
          selectedItem={selectedItem}
          getItemAriaLabel={tabConfig.getItemAriaLabel}
          globalFilter={globalFiltersByTab[tab.id]}
          filterConfig={tabConfig.filterConfig}
          onQueryChange={handleQueryChange}
          getSummaryData={tabConfig.getSummaryData}
          initialSort={tabConfig.initialSort}
          autoSelectFirstRow={tabConfig.autoSelectFirstRow}
          onAddClick={shouldShowAddButton ? handleAddClick(tab.id, tab.configKey) : undefined}
          fastAdd={tabConfig.fastAdd}
          fastAddRequest={fastAddRequests[tab.id] ?? null}
          rowDrag={tabConfig.rowDrag}
          rowDrop={tabConfig.rowDrop}
          rowHeight={tabConfig.rowHeight}
          mobileRowHeight={tabConfig.mobileRowHeight}
          className={listClassName}
          reloadKey={`${reloadKey ?? 0}:${state.listVersions[tab.id] ?? 0}`}
        />
      );
    } else if (tab.type === 'detail' && tab.item) {
      const DetailComponent = tabConfig.detailComponent;
      const canEdit = Boolean(tabConfig.onUpsert && tabConfig.schema);
      const handleEdit = canEdit && tab.parentTabId
        ? () => {
            const editAccess = tabConfig.getEditAccess?.(tab.item);
            const isAllowed = typeof editAccess === 'boolean'
              ? editAccess
              : (editAccess?.allowed ?? true);
            const deniedMessage = typeof editAccess === 'object'
              ? editAccess.message
              : undefined;
            if (!isAllowed) {
              if (deniedMessage) {
                window.alert(deniedMessage);
              }
              return;
            }
            const itemName = resolveItemTitle(tab.item, tabConfig);
            // Route through the unsaved-changes guard: opening an edit tab from
            // a detail view replaces any existing edit tab for the same parent.
            requestChildTabReplace(tab.parentTabId!, 'edit', () => dispatch({
              type: 'OPEN_EDIT_TAB',
              payload: {
                item: tab.item,
                configKey: tab.configKey,
                parentTabId: tab.parentTabId!,
                title: `Edit: ${itemName}`
              }
            }));
          }
        : undefined;
      const handleItemSaved = (savedItem: any) => {
        const getItemId = tabConfig.getItemId;
        let savedId: string | null = null;
        try {
          savedId = getItemId(savedItem);
        } catch {
          savedId = null;
        }
        if (savedId !== null) {
          dispatch({
            type: 'REFRESH_TAB_ITEMS',
            payload: {
              configKey: tab.configKey,
              item: savedItem,
              title: `Detail: ${resolveItemTitle(savedItem, tabConfig)}`,
              matchesItem: (tabItem: any) => {
                try {
                  return getItemId(tabItem) === savedId;
                } catch {
                  return false;
                }
              }
            }
          });
        }
        notifyRecordsChanged(tab.configKey);
        if (tab.parentTabId) {
          dispatch({ type: 'INVALIDATE_LIST', payload: { tabId: tab.parentTabId } });
          queryClient.invalidateQueries({ queryKey: ['tab-counts'] });
        }
      };
      return (
        <DetailComponent
          item={tab.item}
          onClose={() => dispatch({ type: 'REMOVE_TAB', payload: { tabId: tab.id } })}
          onEdit={handleEdit}
          onItemSaved={handleItemSaved}
        />
      );
    } else if (tab.type === 'create') {
      // Use custom createComponent if provided, otherwise use RecordForm
      if (tabConfig.createComponent) {
        const CreateComponent = tabConfig.createComponent;
        const createContext = typeof tabConfig.componentContext === 'function'
          ? tabConfig.componentContext(undefined)
          : tabConfig.componentContext;
        return (
          <div className="data-tab-create">
            <CreateComponent
              schema={tabConfig.schema}
              initialValues={tab.initialValues}
              globalFilter={tab.parentTabId ? globalFiltersByTab[tab.parentTabId] : undefined}
              onSubmit={handleCreateSubmit(tab)}
              onCancel={handleCreateCancel(tab.id)}
              title={tab.title}
              fetchRelatedRecords={fetchRelatedRecords}
              onDirtyChange={createDirtyChangeHandler(tab.id)}
              componentContext={createContext}
            />
          </div>
        );
      } else if (tabConfig.schema) {
        const createContext = typeof tabConfig.componentContext === 'function'
          ? tabConfig.componentContext(undefined)
          : tabConfig.componentContext;
        return (
          <div className="data-tab-create">
            <RecordForm
              schema={tabConfig.schema}
              initialValues={tab.initialValues}
              onSubmit={handleCreateSubmit(tab)}
              onCancel={handleCreateCancel(tab.id)}
              title={tab.title}
              fetchRelatedRecords={fetchRelatedRecords}
              onSchemaFormChange={tabConfig.onChange}
              schemaFormMeta={{
                mode: 'create',
                configKey: tab.configKey
              }}
              componentContext={createContext}
              onDirtyChange={createDirtyChangeHandler(tab.id)}
            />
          </div>
        );
      }
    } else if (tab.type === 'edit' && tab.item) {
      // Use custom editComponent if provided, otherwise use RecordForm
      const deleteHandler = tabConfig.onDelete
        ? async () => {
            const deleted = await tabConfig.onDelete!(tab.item);
            if (deleted) {
              dirtyTabsRef.current.delete(tab.id);
              dispatch({ type: 'REMOVE_TAB', payload: { tabId: tab.id } });
              notifyRecordsChanged(tab.configKey);
              if (tab.parentTabId) {
                dispatch({ type: 'INVALIDATE_LIST', payload: { tabId: tab.parentTabId } });
                queryClient.invalidateQueries({ queryKey: ['tab-counts'] });
              }
            }
          }
        : undefined;
      if (tabConfig.editComponent) {
        const EditComponent = tabConfig.editComponent;
        const editContext = typeof tabConfig.componentContext === 'function'
          ? tabConfig.componentContext(tab.item)
          : tabConfig.componentContext;
        return (
          <div className="data-tab-edit">
            <EditComponent
              schema={tabConfig.editSchema ?? tabConfig.schema}
              initialValues={tab.item}
              globalFilter={tab.parentTabId ? globalFiltersByTab[tab.parentTabId] : undefined}
              onSubmit={handleEditSubmit(tab)}
              onCancel={handleEditCancel(tab.id)}
              onDelete={deleteHandler}
              title={tab.title}
              fetchRelatedRecords={fetchRelatedRecords}
              onDirtyChange={createDirtyChangeHandler(tab.id)}
              componentContext={editContext}
            />
          </div>
        );
      } else if (tabConfig.schema) {
        const editContext = typeof tabConfig.componentContext === 'function'
          ? tabConfig.componentContext(tab.item)
          : tabConfig.componentContext;
        return (
          <div className="data-tab-edit">
            <RecordForm
              schema={tabConfig.editSchema ?? tabConfig.schema}
              initialValues={tab.item}
              onSubmit={handleEditSubmit(tab)}
              onCancel={handleEditCancel(tab.id)}
              onDelete={deleteHandler}
              title={tab.title}
              submitLabel="Save"
              fetchRelatedRecords={fetchRelatedRecords}
              onSchemaFormChange={tabConfig.onChange}
              schemaFormMeta={{
                mode: 'edit',
                configKey: tab.configKey,
                existingItem: tab.item
              }}
              componentContext={editContext}
              onDirtyChange={createDirtyChangeHandler(tab.id)}
            />
          </div>
        );
      }
    }

    return null;
  }, [
    config,
    createDirtyChangeHandler,
    fetchRelatedRecords,
    globalFiltersByTab,
    handleAddClick,
    handleCreateCancel,
    handleCreateSubmit,
    handleEditCancel,
    handleEditSubmit,
    handleItemDoubleClick,
    itemReceiverPanel?.leftPaneDataListClassNameWhenActive,
    isReceiverActive,
    handleSelectionChange,
    notifyRecordsChanged,
    onListQueryChange,
    resolveItemTitle,
    getTotalChangeHandler,
    reloadKey,
    requestChildTabReplace,
    state.listVersions,
    state.tabSelections,
    tabListQueries
  ]);

  if (state.tabs.length === 0) {
    return (
      <div className="data-tab-manager">
        <div className="data-tab-empty">No tabs configured</div>
      </div>
    );
  }

  const visibleTabs = visibleTabIndices
    .map((index) => ({ index, tab: state.tabs[index] }))
    .filter((entry): entry is { index: number; tab: DataTabState } => Boolean(entry.tab));
  const activeTabTitle = state.tabs[state.activeTabIndex]?.title ?? '';
  const isGlobalFilterActive = effectiveGlobalFilterSources.length > 0;
  const isReceiverPanelShown = Boolean(itemReceiverPanel && isReceiverActive && !isMobileSplit);

  return (
    <RelatedRecordsContext.Provider value={relatedRecordsContextValue}>
    <div className="data-tab-manager">
      <div className="data-tab-header">
        <div className="data-tab-labels" role="tablist" aria-label="Data tabs">
          {visibleTabs.map(({ tab, index }) => (
          <div
            key={tab.id}
            id={`data-tab-${tab.id}`}
            className={`data-tab-label ${index === state.activeTabIndex ? 'active' : ''} ${
              isGlobalFilterActive && effectiveGlobalFilterSources.some(s => s.sourceTabId === tab.id) ? 'filter-source' : ''
            }`}
            data-testid={getTabTestId(tab)}
            role="tab"
            aria-label={getTabAriaLabel(tab)}
            aria-selected={index === state.activeTabIndex}
            aria-controls={`data-tab-panel-${tab.id}`}
            tabIndex={0}
            onClick={() => handleTabClick(index)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleTabClick(index);
              }
            }}
          >
            <div className="data-tab-label-content">
              <span className="data-tab-label-text">{getTabTitle(tab)}</span>
              {getTabCount(tab) && (
                <span className="data-tab-label-count" data-testid="data-tab-label-count">{getTabCount(tab)}</span>
              )}
            </div>
            {tab.type === 'list' && (
              <span
                className={`data-tab-filter-dot ${
                  effectiveGlobalFilterSources.some(s => s.sourceTabId === tab.id) ? 'active' : ''
                } ${state.pendingGlobalFilterTabIds.includes(tab.id) ? 'pending' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({
                    type: 'TOGGLE_GLOBAL_FILTER',
                    payload: { tabId: tab.id, additive: e.ctrlKey || e.metaKey }
                  });
                }}
                title={
                  effectiveGlobalFilterSources.some(s => s.sourceTabId === tab.id)
                    ? 'Remove from global filter'
                    : state.pendingGlobalFilterTabIds.includes(tab.id)
                      ? 'Pending filter source — will filter other tabs once a row is selected here. Click to cancel.'
                      : 'Click to set as global filter, Ctrl/Cmd+click to add to the current filter'
                }
                aria-label={
                  effectiveGlobalFilterSources.some(s => s.sourceTabId === tab.id)
                    ? 'Remove global filter'
                    : state.pendingGlobalFilterTabIds.includes(tab.id)
                      ? 'Cancel pending global filter'
                      : 'Set as global filter'
                }
              />
            )}
            {(tab.type === 'detail' || tab.type === 'create' || tab.type === 'edit') && (
              <button
                type="button"
                className="data-tab-close"
                onClick={(e) => handleTabClose(tab.id, e)}
                title="Close tab"
                aria-label="Close tab"
              >
                ×
              </button>
            )}
            </div>
          ))}
          {visibleTabs.length === 0 && (
            <div className="data-tab-labels-empty">No tabs available in this mode</div>
          )}
        </div>
        <div className="data-tab-mobile-nav">
          <button
            className="data-tab-mobile-trigger"
            onClick={() => setIsMobileMenuOpen(v => !v)}
            aria-expanded={isMobileMenuOpen}
            type="button"
          >
            <span>{activeTabTitle}</span>
            <span className="data-tab-mobile-chevron" aria-hidden="true">▾</span>
          </button>
          {isMobileMenuOpen && (
            <>
              <div className="data-tab-mobile-backdrop" onClick={() => setIsMobileMenuOpen(false)} />
              <div className="data-tab-mobile-dropdown" role="listbox">
                {visibleTabs.map(({ tab, index }) => (
                  <button
                    key={tab.id}
                    className={`data-tab-mobile-option ${index === state.activeTabIndex ? 'active' : ''}`}
                    role="option"
                    aria-selected={index === state.activeTabIndex}
                    type="button"
                    onClick={() => { handleTabClick(index); setIsMobileMenuOpen(false); }}
                  >
                    {getTabTitle(tab)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {itemReceiverPanel && !isMobileSplit && (
          <div className="data-tab-header-actions">
            {isReceiverPanelShown && state.globalFilterSources.length > effectiveGlobalFilterSources.length && (
              <span
                className="data-tab-suspended-filters"
                role="status"
                title="Global filters from tabs hidden in this mode are paused and will resume when you exit"
              >
                {state.globalFilterSources.length - effectiveGlobalFilterSources.length === 1
                  ? '1 filter paused in this mode'
                  : `${state.globalFilterSources.length - effectiveGlobalFilterSources.length} filters paused in this mode`}
              </span>
            )}
            <button
              type="button"
              className={`data-tab-receiver-toggle ${isReceiverPanelShown ? 'active' : ''}`}
              onClick={() => applyReceiverActive(!isReceiverActive)}
            >
              {isReceiverPanelShown
                ? (itemReceiverPanel.toggleLabel?.on ?? 'Exit Receiver Mode')
                : (itemReceiverPanel.toggleLabel?.off ?? 'Receiver Mode')}
            </button>
          </div>
        )}
      </div>
      <div className="data-tab-content">
        {isReceiverPanelShown ? (
          <div className="data-tab-content-split" ref={splitContainerRef}>
            <div className="data-tab-main-pane" style={{ flexBasis: `${splitRatio * 100}%` }}>
              <div className="data-tab-panels">
                {state.tabs.map((tab, index) => {
                  const isTabVisible = visibleTabIdSet.has(tab.id);
                  const isActive = isTabVisible && index === state.activeTabIndex;
                  const keepMounted = tab.type === 'create' || tab.type === 'edit';
                  return (
                    <div
                      key={tab.id}
                      id={`data-tab-panel-${tab.id}`}
                      role="tabpanel"
                      aria-labelledby={`data-tab-${tab.id}`}
                      className={`data-tab-panel ${isActive ? 'active' : ''} ${isTabVisible ? '' : 'hidden-by-mode'} ${tab.configKey}`}
                    >
                      {(isActive || keepMounted) && renderTabContent(tab)}
                    </div>
                  );
                })}
              </div>
            </div>
            <div
              className="data-tab-splitter"
              role="separator"
              aria-orientation={isMobileSplit ? 'horizontal' : 'vertical'}
              aria-label="Resize list and receiver panes"
              onMouseDown={handleSplitterMouseDown}
              onTouchStart={handleSplitterTouchStart}
            />
            <div className="data-tab-receiver-pane">
              {itemReceiverPanel?.title && (
                <div className="data-tab-receiver-pane-title">{itemReceiverPanel.title}</div>
              )}
              <div className="data-tab-receiver-pane-content">
                {itemReceiverPanel?.renderPanel()}
              </div>
            </div>
          </div>
        ) : (
          <div className="data-tab-panels">
            {state.tabs.map((tab, index) => {
              const isTabVisible = visibleTabIdSet.has(tab.id);
              const isActive = isTabVisible && index === state.activeTabIndex;
              const keepMounted = tab.type === 'create' || tab.type === 'edit';
              return (
                <div
                  key={tab.id}
                  id={`data-tab-panel-${tab.id}`}
                  role="tabpanel"
                  aria-labelledby={`data-tab-${tab.id}`}
                  className={`data-tab-panel ${isActive ? 'active' : ''} ${isTabVisible ? '' : 'hidden-by-mode'} ${tab.configKey}`}
                >
                  {(isActive || keepMounted) && renderTabContent(tab)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {listContextMenu && (
        <ContextMenu
          position={listContextMenu.position}
          options={listContextMenuOptions}
          onClose={() => setListContextMenu(null)}
        />
      )}
      {pendingCloseTabId && (
        <div className="data-tab-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="unsaved-changes-title">
          <div className="data-tab-confirm-dialog">
            <h3 id="unsaved-changes-title">Unsaved Changes</h3>
            <p>You have unsaved changes. Are you sure you want to close this tab?</p>
            <div className="data-tab-confirm-actions">
              <button
                type="button"
                className="data-tab-confirm-cancel"
                onClick={handleCancelClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="data-tab-confirm-discard"
                onClick={handleConfirmClose}
              >
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </RelatedRecordsContext.Provider>
  );
};


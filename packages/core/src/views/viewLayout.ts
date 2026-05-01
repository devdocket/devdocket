import * as vscode from 'vscode';
import { WorkItem } from '../models/workItem';
import type { ProviderRegistry } from '../services/providerRegistry';
import type { LinkRelation } from './linkDisplay';

export type ViewLayout = 'flat' | 'tree';

export type ViewId = 'inbox' | 'queue' | 'focus' | 'history' | 'sources' | 'watches';

const VIEW_DEFAULTS: Record<ViewId, ViewLayout> = {
  inbox: 'tree',
  queue: 'flat',
  focus: 'flat',
  history: 'flat',
  sources: 'tree',
  watches: 'flat',
};

const STORAGE_KEY = 'devdocket.viewLayout';

const VALID_VIEW_IDS: ReadonlySet<string> = new Set<ViewId>(['inbox', 'queue', 'focus', 'history', 'sources', 'watches']);

let globalState: vscode.Memento | undefined;
const changeListeners: Array<(viewId: ViewId, layout: ViewLayout) => void> = [];

/**
 * Initialize the view-layout store with a Memento backend.
 * Must be called once during activation before any persist operation.
 * Reads (getViewLayout) return defaults if called before init.
 *
 * Performs a one-time migration from the legacy configuration-based
 * storage (`devDocket.viewLayout` in VS Code settings) if globalState
 * has no layouts yet.
 */
export async function initViewLayoutStore(memento: vscode.Memento): Promise<void> {
  globalState = memento;

  // One-time migration from legacy config-based storage
  if (globalState.get(STORAGE_KEY) === undefined) {
    const config = vscode.workspace.getConfiguration('devDocket');
    const legacy: unknown = config.get('viewLayout');
    const migrated = sanitizeLayouts(legacy);
    if (Object.keys(migrated).length > 0) {
      await globalState.update(STORAGE_KEY, migrated);
    }
  }
}

/** Subscribe to layout changes. Returns a disposable that removes the listener. */
export function onDidChangeLayout(listener: (viewId: ViewId, layout: ViewLayout) => void): vscode.Disposable {
  changeListeners.push(listener);
  return { dispose: () => { const i = changeListeners.indexOf(listener); if (i >= 0) { changeListeners.splice(i, 1); } } };
}

/** Read the persisted layout for a given view, falling back to its default. */
export function getViewLayout(viewId: ViewId): ViewLayout {
  if (!globalState) {
    return VIEW_DEFAULTS[viewId];
  }
  const layoutsRaw: unknown = globalState.get(STORAGE_KEY);
  const layouts = (layoutsRaw && typeof layoutsRaw === 'object' && !Array.isArray(layoutsRaw))
    ? layoutsRaw as Record<string, unknown>
    : {};
  const value = layouts[viewId];
  if (value === 'flat' || value === 'tree') {
    return value;
  }
  return VIEW_DEFAULTS[viewId];
}

/** Extract only valid ViewId keys with valid ViewLayout values from an unknown object. */
function sanitizeLayouts(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (VALID_VIEW_IDS.has(key) && (value === 'flat' || value === 'tree')) {
      result[key] = value;
    }
  }
  return result;
}

/** Toggle the layout for a view between flat and tree and persist the choice. */
export async function toggleViewLayout(viewId: ViewId): Promise<void> {
  const current = getViewLayout(viewId);
  const next = current === 'flat' ? 'tree' : 'flat';
  await applyViewLayout(viewId, next);
}

/** Set a specific layout for a view. No-ops if already in the requested layout. */
export async function setViewLayout(viewId: ViewId, layout: ViewLayout): Promise<void> {
  if (getViewLayout(viewId) === layout) {
    return;
  }
  await applyViewLayout(viewId, layout);
}

async function applyViewLayout(viewId: ViewId, layout: ViewLayout): Promise<void> {
  if (!globalState) {
    throw new Error('View layout store not initialized — call initViewLayoutStore() first');
  }
  const existing = sanitizeLayouts(globalState.get(STORAGE_KEY));
  existing[viewId] = layout;
  await globalState.update(STORAGE_KEY, existing);
  for (const listener of [...changeListeners]) {
    try {
      listener(viewId, layout);
    } catch {
      // Isolate listener errors so remaining listeners still fire
    }
  }
}

/** @internal — reset module state between tests. */
export function _resetViewLayoutStore(): void {
  globalState = undefined;
  changeListeners.length = 0;
}

/**
 * Group node used by Queue, Focus, and History views in tree mode.
 * Items that share a providerId are grouped under one of these nodes;
 * manually-created items (no providerId) are grouped under "Other".
 */
export interface ProviderGroupNode {
  kind: 'providerGroup';
  label: string;
  providerId: string | undefined;
}

export function isProviderGroupNode(element: unknown): element is ProviderGroupNode {
  return (
    typeof element === 'object' &&
    element !== null &&
    (element as Record<string, unknown>).kind === 'providerGroup'
  );
}

/**
 * Composable layout state that fires a change event when the layout toggles.
 * Providers own one of these instead of duplicating the getter/setter boilerplate.
 */
export class LayoutState {
  private _layout: ViewLayout;

  constructor(
    defaultLayout: ViewLayout,
    private readonly fireChange: () => void,
  ) {
    this._layout = defaultLayout;
  }

  get value(): ViewLayout { return this._layout; }
  set value(next: ViewLayout) {
    if (this._layout !== next) {
      this._layout = next;
      this.fireChange();
    }
  }
}

/**
 * Normalize a providerId: treat empty/whitespace-only strings the same as undefined.
 */
function normalizeProviderId(providerId: string | null | undefined): string | undefined {
  return providerId?.trim() || undefined;
}

/**
 * Normalize a group name: treat empty/whitespace-only strings the same as undefined.
 */
function normalizeGroup(group: string | null | undefined): string | undefined {
  return group?.trim() || undefined;
}

/**
 * Resolves a raw providerId to a human-friendly display name.
 * When not supplied, the raw providerId is used as-is.
 */
export type LabelResolver = (providerId: string) => string;

/**
 * Looks up the live title for a provider-backed item.
 * Returns `undefined` when the discovered item is not found,
 * signalling the caller to fall back to the persisted title.
 */
export type TitleResolver = (providerId: string, externalId: string) => string | undefined;

/**
 * Group WorkItems by providerId into ProviderGroupNodes.
 * Items without a providerId (or with an empty/whitespace one) are grouped under "Other" (sorted last).
 *
 * @param labelResolver  Optional function that maps a providerId to a display name.
 */
export function groupByProvider(items: WorkItem[], labelResolver?: LabelResolver): ProviderGroupNode[] {
  const seen = new Set<string | undefined>();
  for (const item of items) {
    seen.add(normalizeProviderId(item.providerId));
  }

  const result: ProviderGroupNode[] = [];
  for (const providerId of seen) {
    result.push({
      kind: 'providerGroup',
      label: providerId ? (labelResolver?.(providerId) ?? providerId) : 'Other',
      providerId,
    });
  }
  return result.sort((a, b) => {
    if (!a.providerId && !b.providerId) { return 0; }
    if (!a.providerId) { return 1; }
    if (!b.providerId) { return -1; }
    return a.label.localeCompare(b.label);
  });
}

/**
 * Common getChildren routing for providers that show WorkItems
 * in either flat or tree (grouped-by-provider) mode.
 *
 * Tree mode uses a two-level hierarchy matching the Inbox:
 *   provider → sub-group (item.group) → items
 * Items without a group appear directly under the provider node.
 *
 * @param element        The tree element being expanded (undefined = root)
 * @param getItems       Returns all relevant WorkItems for this view
 * @param sortItems      Sorts a flat list of items (view-specific ordering)
 * @param layout         Current layout mode
 * @param labelResolver  Optional function that maps a providerId to a display name.
 */
export function getTreeModeChildren(
  element: WorkItem | ProviderGroupNode | SubGroupNode | undefined,
  getItems: () => WorkItem[],
  sortItems: (items: WorkItem[]) => WorkItem[],
  layout: ViewLayout,
  labelResolver?: LabelResolver,
): (WorkItem | ProviderGroupNode | SubGroupNode)[] {
  if (!element) {
    const items = getItems();
    if (layout === 'flat') {
      return sortItems(items);
    }
    return groupByProvider(items, labelResolver);
  }

  if (isProviderGroupNode(element)) {
    const providerItems = getItems().filter(
      i => normalizeProviderId(i.providerId) === element.providerId,
    );
    return getProviderChildren(providerItems, element.providerId, sortItems);
  }

  if (isSubGroupNode(element)) {
    return sortItems(
      getItems().filter(
        i => normalizeProviderId(i.providerId) === element.providerId && normalizeGroup(i.group) === element.groupName,
      ),
    );
  }

  return [];
}

/**
 * Build children for a provider group node: sub-group nodes for items that
 * have a `group` value, plus ungrouped items rendered directly.
 */
function getProviderChildren(
  items: WorkItem[],
  providerId: string | undefined,
  sortItems: (items: WorkItem[]) => WorkItem[],
): (SubGroupNode | WorkItem)[] {
  const groups = new Set<string>();
  const ungrouped: WorkItem[] = [];

  for (const item of items) {
    const normalizedGroup = normalizeGroup(item.group);
    if (normalizedGroup) {
      groups.add(normalizedGroup);
    } else {
      ungrouped.push(item);
    }
  }

  const subGroups: SubGroupNode[] = [];

  for (const groupName of groups) {
    subGroups.push({ kind: 'subGroup', label: groupName, providerId, groupName });
  }

  const sortedSubGroups = subGroups.sort((a, b) => a.label.localeCompare(b.label));
  const sortedUngrouped = sortItems(ungrouped);

  return [...sortedSubGroups, ...sortedUngrouped];
}

/** Create a TreeItem for a ProviderGroupNode with a view-specific id prefix and contextValue. */
export function createProviderGroupTreeItem(
  node: ProviderGroupNode,
  prefix: string,
  contextValue: string,
  count?: number,
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  const idSuffix = node.providerId ? `provider:${node.providerId}` : 'other';
  treeItem.id = `${prefix}::group::${idSuffix}`;
  treeItem.contextValue = contextValue;
  treeItem.iconPath = new vscode.ThemeIcon(node.providerId ? 'plug' : 'circle-filled');
  if (count !== undefined) {
    treeItem.description = `${count}`;
  }
  return treeItem;
}

/** Create a TreeItem for a SubGroupNode. */
export function createSubGroupTreeItem(
  node: SubGroupNode,
  prefix: string,
  count?: number,
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  const providerPart = node.providerId ? `provider:${node.providerId}` : 'other';
  treeItem.id = `${prefix}::subgroup::${providerPart}::${node.groupName}`;
  treeItem.contextValue = `${prefix}SubGroup`;
  treeItem.iconPath = new vscode.ThemeIcon('folder');
  if (count !== undefined) {
    treeItem.description = `${count}`;
  }
  return treeItem;
}

/**
 * Sub-group node within a provider group. Groups items that share the same
 * `item.group` value under a provider node, mirroring the Inbox's two-level hierarchy.
 */
export interface SubGroupNode {
  kind: 'subGroup';
  label: string;
  providerId: string | undefined;
  groupName: string;
}

export function isSubGroupNode(element: unknown): element is SubGroupNode {
  return (
    typeof element === 'object' &&
    element !== null &&
    (element as Record<string, unknown>).kind === 'subGroup'
  );
}

export interface LinkedWorkItemNode extends WorkItem {
  linkedParentId: string;
  linkedRelation: LinkRelation;
  linkedNodeId: string;
}

export function isLinkedWorkItemNode(element: unknown): element is LinkedWorkItemNode {
  return (
    typeof element === 'object' &&
    element !== null &&
    typeof (element as LinkedWorkItemNode).linkedParentId === 'string' &&
    typeof (element as LinkedWorkItemNode).linkedRelation === 'string' &&
    typeof (element as LinkedWorkItemNode).linkedNodeId === 'string'
  );
}

/**
 * Element type for providers that display WorkItems with optional provider grouping.
 */
export type WorkItemElement = WorkItem | ProviderGroupNode | SubGroupNode;

/**
 * Abstract base for Focus, Queue, and History tree providers.
 * Encapsulates the shared layout state, event wiring, getChildren routing,
 * and getTreeItem delegation so subclasses only define view-specific logic.
 */
export abstract class WorkItemViewProvider implements vscode.TreeDataProvider<WorkItemElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  protected readonly disposables: vscode.Disposable[] = [];
  private readonly _layoutState: LayoutState;
  private _countsCache: Map<string, number> | undefined;

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(
    protected readonly workGraph: import('../services/workGraph').WorkGraph,
    defaultLayout: ViewLayout,
    private readonly labelResolver?: LabelResolver,
    providerChangeEvent?: import('vscode').Event<void>,
    private readonly titleResolver?: TitleResolver,
    discoveredItemsChangeEvent?: import('vscode').Event<void>,
  ) {
    this._layoutState = new LayoutState(defaultLayout, () => this.refresh());
    this.disposables.push(
      workGraph.onDidChange(() => this.refresh()),
    );
    if (providerChangeEvent) {
      this.disposables.push(
        providerChangeEvent(() => this.refresh()),
      );
    }
    if (discoveredItemsChangeEvent) {
      this.disposables.push(
        discoveredItemsChangeEvent(() => this.refresh()),
      );
    }
  }

  /**
   * Resolve the display title for a work item.
   * For provider-backed items, returns the live title from the provider if available;
   * otherwise falls back to the persisted title.
   */
  protected resolveTitle(item: WorkItem): string {
    if (item.providerId && item.externalId && this.titleResolver) {
      return this.titleResolver(item.providerId, item.externalId) ?? item.title;
    }
    return item.title;
  }

  refresh(): void {
    this._countsCache = undefined;
    this._onDidChangeTreeData.fire();
  }

  protected getProviderLabel(providerId: string | undefined): string | undefined {
    const normalizedProviderId = providerId?.trim();
    if (!normalizedProviderId) {
      return undefined;
    }
    return this.labelResolver?.(normalizedProviderId) ?? normalizedProviderId;
  }

  /** Join non-empty description parts with a separator. */
  protected buildDescription(...parts: (string | undefined)[]): string | undefined {
    const filtered = parts
      .map(p => p?.trim())
      .filter((p): p is string => p !== undefined && p.length > 0);
    return filtered.length > 0 ? filtered.join(' · ') : undefined;
  }

  /** Return the WorkItems this view cares about (before sorting). */
  protected abstract getItems(): WorkItem[];

  /** View-specific sort order applied in both flat and group-expanded modes. */
  protected abstract sortItems(items: WorkItem[]): WorkItem[];

  /** ID prefix for provider-group tree items (e.g. 'focus', 'queue'). */
  protected abstract readonly groupPrefix: string;

  /** contextValue for provider-group tree items (e.g. 'focusGroup'). */
  protected abstract readonly groupContextValue: string;

  /** Create a TreeItem for a WorkItem (not a group node). */
  protected abstract createWorkItemTreeItem(item: WorkItem): vscode.TreeItem;

  /** Return child work items shown beneath a top-level work item. */
  protected getItemChildren(_item: WorkItem): WorkItem[] {
    return [];
  }

  protected hasItemChildren(item: WorkItem): boolean {
    return !isLinkedWorkItemNode(item) && this.getItemChildren(item).length > 0;
  }

  private ensureCountsCache(): Map<string, number> {
    if (!this._countsCache) {
      const counts = new Map<string, number>();
      for (const item of this.getItems()) {
        const normalizedProvider = normalizeProviderId(item.providerId) ?? '';
        const providerKey = `provider:${normalizedProvider}`;
        counts.set(providerKey, (counts.get(providerKey) ?? 0) + 1);

        // Per-provider sub-group key (used when providerId is known)
        const normalizedGroup = normalizeGroup(item.group) ?? '';
        const groupKeyWithProvider = `group:${normalizedProvider}:${normalizedGroup}`;
        counts.set(groupKeyWithProvider, (counts.get(groupKeyWithProvider) ?? 0) + 1);

        // Provider-less sub-group key (used only for the "Other" provider group)
        if (!normalizedProvider) {
          const groupKeyOnly = `group-only:${normalizedGroup}`;
          counts.set(groupKeyOnly, (counts.get(groupKeyOnly) ?? 0) + 1);
        }
      }
      this._countsCache = counts;
    }
    return this._countsCache;
  }

  getTreeItem(element: WorkItemElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      const counts = this.ensureCountsCache();
      const providerKey = `provider:${element.providerId ?? ''}`;
      const count = counts.get(providerKey) ?? 0;
      return createProviderGroupTreeItem(element, this.groupPrefix, this.groupContextValue, count);
    }
    if (isSubGroupNode(element)) {
      const counts = this.ensureCountsCache();
      // "Other" provider sub-groups (no providerId) use the provider-less key;
      // named-provider sub-groups use the per-provider key
      const groupKey = element.providerId !== undefined
        ? `group:${element.providerId}:${element.groupName}`
        : `group-only:${element.groupName}`;
      const count = counts.get(groupKey) ?? 0;
      return createSubGroupTreeItem(element, this.groupPrefix, count);
    }
    return this.createWorkItemTreeItem(element);
  }

  getParent(element: WorkItemElement): WorkItemElement | undefined {
    if (this._layoutState.value === 'flat') {
      return undefined;
    }
    if (isProviderGroupNode(element)) {
      return undefined;
    }
    if (isSubGroupNode(element)) {
      const label = element.providerId
        ? (this.labelResolver?.(element.providerId) ?? element.providerId)
        : 'Other';
      return { kind: 'providerGroup', label, providerId: element.providerId };
    }
    // WorkItem — find its parent node
    const item = element as WorkItem;
    if (isLinkedWorkItemNode(item)) {
      return this.workGraph.getItem(item.linkedParentId);
    }

    const pid = item.providerId?.trim() || undefined;
    const grp = item.group?.trim() || undefined;
    if (grp) {
      return { kind: 'subGroup', label: grp, providerId: pid, groupName: grp };
    }
    const label = pid ? (this.labelResolver?.(pid) ?? pid) : 'Other';
    return { kind: 'providerGroup', label, providerId: pid };
  }

  getChildren(element?: WorkItemElement): WorkItemElement[] {
    if (element && !isProviderGroupNode(element) && !isSubGroupNode(element)) {
      return this.getItemChildren(element);
    }

    return getTreeModeChildren(
      element,
      () => this.getItems(),
      items => this.sortItems(items),
      this._layoutState.value,
      this.labelResolver,
    );
  }

  /**
   * Build the four resolver arguments for the WorkItemViewProvider constructor
   * from an optional ProviderRegistry. Subclasses with a ProviderRegistry
   * parameter use this to avoid repeating the same closure construction.
   */
  protected static buildProviderArgs(registry: ProviderRegistry | undefined): [
    LabelResolver | undefined,
    vscode.Event<void> | undefined,
    TitleResolver | undefined,
    vscode.Event<void> | undefined,
  ] {
    return [
      registry ? (id: string) => registry.getProviderLabel(id) : undefined,
      registry?.onDidRegisterProvider,
      registry ? (pid: string, eid: string) => registry.getDiscoveredItems(pid).find(d => d.externalId === eid)?.title : undefined,
      registry?.onDidChangeDiscoveredItems,
    ];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

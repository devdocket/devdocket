import * as vscode from 'vscode';
import { WorkItem } from '../models/workItem';

export type ViewLayout = 'flat' | 'tree';

export type ViewId = 'inbox' | 'queue' | 'focus' | 'history' | 'sources';

const VIEW_DEFAULTS: Record<ViewId, ViewLayout> = {
  inbox: 'tree',
  queue: 'flat',
  focus: 'flat',
  history: 'flat',
  sources: 'tree',
};

/** Read the persisted layout for a given view, falling back to its default. */
export function getViewLayout(viewId: ViewId): ViewLayout {
  const config = vscode.workspace.getConfiguration('workcenter');
  const layoutsRaw: unknown = config.get('viewLayout');
  const layouts = (layoutsRaw && typeof layoutsRaw === 'object' && !Array.isArray(layoutsRaw))
    ? layoutsRaw as Record<string, unknown>
    : {};
  const value = layouts[viewId];
  if (value === 'flat' || value === 'tree') {
    return value;
  }
  return VIEW_DEFAULTS[viewId];
}

const VALID_VIEW_IDS: ReadonlySet<string> = new Set<ViewId>(['inbox', 'queue', 'focus', 'history', 'sources']);

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
  await setViewLayout(viewId, next);
}

/** Set a specific layout for a view. No-ops if already in the requested layout. */
export async function setViewLayout(viewId: ViewId, layout: ViewLayout): Promise<void> {
  const current = getViewLayout(viewId);
  if (current === layout) {
    return;
  }
  const config = vscode.workspace.getConfiguration('workcenter');

  // Only target Workspace or Global scope. Workspace-folder scope requires a
  // resource URI that toggle commands don't have, so updating it without one
  // could silently write to the wrong folder in multi-root workspaces.
  const inspection = config.inspect('viewLayout');

  if (inspection?.workspaceFolderValue !== undefined) {
    void vscode.window.showWarningMessage(
      'A workspace-folder setting is overriding the layout for this view. ' +
      'Update or remove "workcenter.viewLayout" in your folder settings to use the toggle.',
    );
  }

  const hasWorkspaceValue = inspection?.workspaceValue !== undefined;
  const scopeValue = hasWorkspaceValue ? inspection.workspaceValue : inspection?.globalValue;
  const target = hasWorkspaceValue
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  const layouts = sanitizeLayouts(scopeValue);
  layouts[viewId] = layout;

  await config.update('viewLayout', layouts, target);
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
 * Resolves a raw providerId to a human-friendly display name.
 * When not supplied, the raw providerId is used as-is.
 */
export type LabelResolver = (providerId: string) => string;

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
        i => normalizeProviderId(i.providerId) === element.providerId && i.group === element.groupName,
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
    if (item.group) {
      groups.add(item.group);
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
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  const idSuffix = node.providerId ? `provider:${node.providerId}` : 'other';
  treeItem.id = `${prefix}::group::${idSuffix}`;
  treeItem.contextValue = contextValue;
  treeItem.iconPath = new vscode.ThemeIcon(node.providerId ? 'plug' : 'circle-filled');
  return treeItem;
}

/** Create a TreeItem for a SubGroupNode. */
export function createSubGroupTreeItem(
  node: SubGroupNode,
  prefix: string,
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  const providerPart = node.providerId ? `provider:${node.providerId}` : 'other';
  treeItem.id = `${prefix}::subgroup::${providerPart}::${node.groupName}`;
  treeItem.contextValue = `${prefix}SubGroup`;
  treeItem.iconPath = new vscode.ThemeIcon('folder');
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

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(
    protected readonly workGraph: import('../services/workGraph').WorkGraph,
    defaultLayout: ViewLayout,
    private readonly labelResolver?: LabelResolver,
    providerChangeEvent?: import('vscode').Event<void>,
  ) {
    this._layoutState = new LayoutState(defaultLayout, () => this._onDidChangeTreeData.fire());
    this.disposables.push(
      workGraph.onDidChange(() => this._onDidChangeTreeData.fire()),
    );
    if (providerChangeEvent) {
      this.disposables.push(
        providerChangeEvent(() => this._onDidChangeTreeData.fire()),
      );
    }
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

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

  getTreeItem(element: WorkItemElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      return createProviderGroupTreeItem(element, this.groupPrefix, this.groupContextValue);
    }
    if (isSubGroupNode(element)) {
      return createSubGroupTreeItem(element, this.groupPrefix);
    }
    return this.createWorkItemTreeItem(element);
  }

  getChildren(element?: WorkItemElement): WorkItemElement[] {
    return getTreeModeChildren(
      element,
      () => this.getItems(),
      items => this.sortItems(items),
      this._layoutState.value,
      this.labelResolver,
    );
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

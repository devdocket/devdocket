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
  const config = vscode.workspace.getConfiguration('workcenter');
  const current = getViewLayout(viewId);

  // Only target Workspace or Global scope. Workspace-folder scope requires a
  // resource URI that toggle commands don't have, so updating it without one
  // could silently write to the wrong folder in multi-root workspaces.
  const inspection = config.inspect('viewLayout');
  const hasWorkspaceValue = inspection?.workspaceValue !== undefined;
  const scopeValue = hasWorkspaceValue ? inspection.workspaceValue : inspection?.globalValue;
  const target = hasWorkspaceValue
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  const layouts = sanitizeLayouts(scopeValue);
  layouts[viewId] = current === 'flat' ? 'tree' : 'flat';

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
 * Group WorkItems by providerId into ProviderGroupNodes.
 * Items without a providerId (or with an empty/whitespace one) are grouped under "Other" (sorted last).
 */
export function groupByProvider(items: WorkItem[]): ProviderGroupNode[] {
  const groups = new Map<string | undefined, WorkItem[]>();
  for (const item of items) {
    const key = normalizeProviderId(item.providerId);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const result: ProviderGroupNode[] = [];
  for (const [providerId] of groups) {
    result.push({
      kind: 'providerGroup',
      label: providerId ?? 'Other',
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
 * @param element   The tree element being expanded (undefined = root)
 * @param getItems  Returns all relevant WorkItems for this view
 * @param sortItems Sorts a flat list of items (view-specific ordering)
 * @param layout    Current layout mode
 */
export function getTreeModeChildren(
  element: WorkItem | ProviderGroupNode | undefined,
  getItems: () => WorkItem[],
  sortItems: (items: WorkItem[]) => WorkItem[],
  layout: ViewLayout,
): (WorkItem | ProviderGroupNode)[] {
  if (!element) {
    const items = getItems();
    if (layout === 'flat') {
      return sortItems(items);
    }
    return groupByProvider(items);
  }

  if (isProviderGroupNode(element)) {
    return sortItems(
      getItems().filter(i => normalizeProviderId(i.providerId) === element.providerId),
    );
  }

  return [];
}

/** Create a TreeItem for a ProviderGroupNode with a view-specific id prefix and contextValue. */
export function createProviderGroupTreeItem(
  node: ProviderGroupNode,
  prefix: string,
  contextValue: string,
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  treeItem.id = `${prefix}::group::${node.providerId ?? '__other__'}`;
  treeItem.contextValue = contextValue;
  treeItem.iconPath = new vscode.ThemeIcon(node.providerId ? 'plug' : 'circle-filled');
  return treeItem;
}

/**
 * Element type for providers that display WorkItems with optional provider grouping.
 */
export type WorkItemElement = WorkItem | ProviderGroupNode;

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
  ) {
    this._layoutState = new LayoutState(defaultLayout, () => this._onDidChangeTreeData.fire());
    this.disposables.push(
      workGraph.onDidChange(() => this._onDidChangeTreeData.fire()),
    );
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
    return this.createWorkItemTreeItem(element);
  }

  getChildren(element?: WorkItemElement): WorkItemElement[] {
    return getTreeModeChildren(
      element,
      () => this.getItems(),
      items => this.sortItems(items),
      this._layoutState.value,
    );
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

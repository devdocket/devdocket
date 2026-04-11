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

  // Persist this UI preference at workspace scope when available; otherwise use global scope
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
 * Group WorkItems by providerId into ProviderGroupNodes.
 * Items without a providerId are grouped under "Other" (sorted last).
 */
export function groupByProvider(items: WorkItem[]): ProviderGroupNode[] {
  const groups = new Map<string | undefined, WorkItem[]>();
  for (const item of items) {
    const key = item.providerId ?? undefined;
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
      getItems().filter(i => (i.providerId ?? undefined) === element.providerId),
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

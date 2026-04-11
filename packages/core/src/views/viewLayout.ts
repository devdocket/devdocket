import * as vscode from 'vscode';

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

/** Toggle the layout for a view between flat and tree and persist the choice. */
export async function toggleViewLayout(viewId: ViewId): Promise<void> {
  const config = vscode.workspace.getConfiguration('workcenter');
  const raw: unknown = config.get('viewLayout');
  const layouts: Record<string, string> = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? { ...(raw as Record<string, string>) }
    : {};
  const current = getViewLayout(viewId);
  layouts[viewId] = current === 'flat' ? 'tree' : 'flat';

  // Update in workspace scope if one exists, otherwise global
  const inspection = config.inspect('viewLayout');
  const target = inspection?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
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

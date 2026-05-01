import * as vscode from 'vscode';
import { ACTIVITY_TYPES, type ActivityType } from '../models/activityLog';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { ProviderRegistry } from '../services/providerRegistry';
import type { ProviderLabelCache } from '../storage/providerLabelCache';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { showProviderHealthQuickPick } from '../views/providerHealthStatusBar';
import { logger } from '../services/logger';
import type { ResolvedItem } from '../api/types';
import type { ViewRevealer } from '../services/viewRevealer';
import { isSafeUrl } from '../utils/url';
import { wrapCommand } from './commandUtils';

async function handleCreateItemFromUrl(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
  revealer?: ViewRevealer,
): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: 'Enter a URL to create a work item from',
  });
  if (!url?.trim()) { return; }

  if (!isSafeUrl(url.trim())) {
    void vscode.window.showErrorMessage('DevDocket: Please enter a valid HTTP or HTTPS URL');
    return;
  }

  let details: ResolvedItem | undefined;
  try {
    details = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DevDocket: Fetching item details…', cancellable: true },
      (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return providerRegistry.resolveUrl(url.trim(), controller.signal);
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return;
    }
    throw error;
  }

  if (!details) {
    void vscode.window.showErrorMessage('DevDocket: No provider recognised this URL');
    return;
  }

  const existing = workGraph.findItemByProvenance(details.providerId, details.externalId);
  if (existing) {
    const providerLabel = existing.providerId ? labelCache.get(existing.providerId) : undefined;
    WorkItemEditorPanel.open(context, workGraph, providerRegistry, existing, providerLabel);
    void vscode.window.showInformationMessage('DevDocket: Item already exists for this source item');
    return;
  }

  const group = details.group?.trim() || undefined;
  const createdItem = await workGraph.createItem(
    { title: details.title, notes: details.notes },
    { providerId: details.providerId, externalId: details.externalId, url: details.url, ...(group ? { group } : {}) },
  );

  const providerLabel = createdItem.providerId ? labelCache.get(createdItem.providerId) : undefined;
  WorkItemEditorPanel.open(context, workGraph, providerRegistry, createdItem, providerLabel);
  void vscode.window.showInformationMessage(`DevDocket: Created "${details.title}"`);
  void revealer?.revealInQueue(createdItem.id);
}

function handleEditItem(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
  item?: { id?: string },
): void {
  if (!item?.id) { return; }
  const workItem = workGraph.getItem(item.id);
  if (workItem) {
    const providerLabel = workItem.providerId ? labelCache.get(workItem.providerId) : undefined;
    WorkItemEditorPanel.open(context, workGraph, providerRegistry, workItem, providerLabel);
  }
}

async function handleOpenInBrowser(workGraph: WorkGraph, item?: { id?: string; url?: string }): Promise<void> {
  if (!item || (!item.id && !item.url)) {
    void vscode.window.showWarningMessage('DevDocket: Select an item to open in the browser.');
    return;
  }
  const workItem = item.id ? workGraph.getItem(item.id) : undefined;
  const url = workItem?.url ?? item.url;
  if (!url) {
    void vscode.window.showWarningMessage('This item has no URL to open.');
    return;
  }
  const safeUrl = isSafeUrl(url);
  if (!safeUrl) {
    const display = url.length > 100 ? url.slice(0, 100) + '…' : url;
    const sanitized = display.replace(/[\n\r]/g, ' ');
    void vscode.window.showWarningMessage(`Cannot open non-web URL: ${sanitized}`);
    return;
  }
  const opened = await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
  if (!opened) {
    void vscode.window.showWarningMessage('Failed to open URL in the browser.');
  }
}

async function handleCopyUrl(workGraph: WorkGraph, item?: { id?: string; url?: string }): Promise<void> {
  if (!item || (!item.id && !item.url)) {
    void vscode.window.showWarningMessage('DevDocket: Select an item to copy its URL.');
    return;
  }
  const workItem = item.id ? workGraph.getItem(item.id) : undefined;
  const url = workItem?.url ?? item.url;
  if (!url) {
    void vscode.window.showWarningMessage('This item has no URL to copy.');
    return;
  }

  await vscode.env.clipboard.writeText(url);
  vscode.window.setStatusBarMessage('DevDocket: URL copied to clipboard', 3000);
}

async function handleRunAction(
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  item?: { id?: string },
): Promise<void> {
  if (!item?.id) { return; }
  const workItem = workGraph.getItem(item.id);
  if (!workItem) {
    return;
  }
  const actions = actionRegistry.getActionsFor(workItem);
  if (actions.length === 0) {
    logger.warn(`No actions available for item ${workItem.id}`);
    void vscode.window.showInformationMessage('No actions available for this item.');
    return;
  }
  const picks = actions.map((a) => ({ label: a.label, actionId: a.id }));
  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select an action',
  });
  if (selected) {
    const action = actionRegistry.getAction(selected.actionId);
    if (action) {
      try {
        logger.info(`Running action: ${selected.actionId} on item ${workItem.id}`);
        await action.run(workItem);
      } catch (err: unknown) {
        logger.error('Action failed: ' + selected.label, err);
        const detail = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`DevDocket: Action "${selected.label}" failed — ${detail}`);
      }
    }
  }
}

async function handleRefresh(providerRegistry: ProviderRegistry): Promise<void> {
  logger.info('Manual refresh triggered');
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'DevDocket: Refreshing…',
    },
    () => providerRegistry.refreshAll(),
  );
}

export function registerGeneralCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
  revealer?: ViewRevealer,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.refresh',
      wrapCommand('Failed to refresh', () => handleRefresh(providerRegistry))),
    vscode.commands.registerCommand('devdocket.createItemFromUrl',
      wrapCommand('Failed to create item from URL', () => handleCreateItemFromUrl(context, workGraph, providerRegistry, labelCache, revealer))),
    vscode.commands.registerCommand('devdocket.editItem',
      wrapCommand('Failed to open editor', (item) => handleEditItem(context, workGraph, providerRegistry, labelCache, item))),
    vscode.commands.registerCommand('devdocket.openInBrowser',
      wrapCommand('Failed to open in browser', (item) => handleOpenInBrowser(workGraph, item))),
    vscode.commands.registerCommand('devdocket.copyUrl',
      wrapCommand('Failed to copy URL', (item) => handleCopyUrl(workGraph, item))),
    vscode.commands.registerCommand('devdocket.runAction',
      wrapCommand('Failed to run action', (item) => handleRunAction(workGraph, actionRegistry, item))),
    vscode.commands.registerCommand('devdocket.showProviderHealthQuickPick',
      wrapCommand('Failed to show provider health quick pick', () => showProviderHealthQuickPick(providerRegistry))),
    vscode.commands.registerCommand('devdocket.addActivity',
      (itemId: string, type: string, detail?: unknown) => {
        if (!ACTIVITY_TYPES.includes(type as ActivityType)) {
          throw new Error(`Invalid activity type: ${type}. Expected one of: ${ACTIVITY_TYPES.join(', ')}`);
        }
        if (detail !== undefined && typeof detail !== 'string') {
          throw new Error('Activity detail must be a string or undefined');
        }
        return workGraph.addActivity(itemId, type as ActivityType, detail);
      }),
  );
}

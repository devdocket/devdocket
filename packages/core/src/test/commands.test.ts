import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { registerCommands, isSafeUrl } from '../commands/commands';
import type { WorkGraph } from '../services/workGraph';
import type { ActionRegistry } from '../services/actionRegistry';
import type { ProviderRegistry } from '../services/providerRegistry';
import type { DiscoveredStateStore } from '../storage/discoveredStateStore';
import type { ProviderLabelCache } from '../storage/providerLabelCache';
import type { InboxItem, InboxProviderNode, InboxGroupNode } from '../views/inboxTreeProvider';
import type { SourceItemNode, SourceProviderNode, SourceGroupNode } from '../views/sourcesTreeProvider';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { logger } from '../services/logger';

vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── helpers ──────────────────────────────────────────────────────────

function createWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wc-test-1',
    title: 'Test Item',
    state: WorkItemState.New,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: 'item',
    providerId: 'github',
    externalId: 'ext-1',
    title: 'Inbox Issue',
    url: 'https://github.com/org/repo/issues/1',
    ...overrides,
  };
}

function makeSourceItem(overrides: Partial<SourceItemNode> = {}): SourceItemNode {
  return {
    kind: 'item',
    providerId: 'github',
    externalId: 'ext-2',
    title: 'Source Issue',
    url: 'https://github.com/org/repo/issues/2',
    ...overrides,
  };
}

type UsedWorkGraphMethods = Pick<
  WorkGraph,
  'transitionState' | 'getItem' | 'createItem' | 'findItemByProvenance' | 'moveItem' | 'deleteItem'
>;

function createMockWorkGraph(): { [K in keyof UsedWorkGraphMethods]: Mock } {
  return {
    transitionState: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(async () => createWorkItem()),
    findItemByProvenance: vi.fn(),
    moveItem: vi.fn(),
    deleteItem: vi.fn(),
  };
}

type UsedActionRegistryMethods = Pick<ActionRegistry, 'getActionsFor' | 'getAction'>;

function createMockActionRegistry(): { [K in keyof UsedActionRegistryMethods]: Mock } {
  return {
    getActionsFor: vi.fn(() => []),
    getAction: vi.fn(),
  };
}

type UsedStateStoreMethods = Pick<DiscoveredStateStore, 'setState' | 'setStates'>;

function createMockStateStore(): { [K in keyof UsedStateStoreMethods]: Mock } {
  return {
    setState: vi.fn(),
    setStates: vi.fn(),
  };
}

type UsedProviderRegistryMethods = Pick<ProviderRegistry, 'refreshAll'>;

function createMockProviderRegistry(): { [K in keyof UsedProviderRegistryMethods]: Mock } {
  return {
    refreshAll: vi.fn().mockResolvedValue(undefined),
  };
}

type UsedLabelCacheMethods = Pick<ProviderLabelCache, 'get'>;

function createMockLabelCache(): { [K in keyof UsedLabelCacheMethods]: Mock } {
  return {
    get: vi.fn(),
  };
}

// ── test setup ───────────────────────────────────────────────────────

// Capture handlers registered via vscode.commands.registerCommand
let commandHandlers: Map<string, (...args: any[]) => any>;

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe('registerCommands', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let actionRegistry: ReturnType<typeof createMockActionRegistry>;
  let stateStore: ReturnType<typeof createMockStateStore>;
  let providerRegistry: ReturnType<typeof createMockProviderRegistry>;
  let labelCache: ReturnType<typeof createMockLabelCache>;
  let ctx: vscode.ExtensionContext;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    commandHandlers = new Map();
    (vscode.commands.registerCommand as Mock).mockImplementation(
      (id: string, handler: (...args: any[]) => any) => {
        commandHandlers.set(id, handler);
        return { dispose: vi.fn() };
      },
    );

    // Stub WorkItemEditorPanel.open to avoid needing full vscode.ViewColumn
    vi.spyOn(WorkItemEditorPanel, 'open').mockImplementation(() => {});

    workGraph = createMockWorkGraph();
    actionRegistry = createMockActionRegistry();
    stateStore = createMockStateStore();
    providerRegistry = createMockProviderRegistry();
    labelCache = createMockLabelCache();
    ctx = createMockContext();

    registerCommands(ctx, workGraph as any, actionRegistry as any, stateStore as any, providerRegistry as any, labelCache as any);
  });

  // helper to invoke a registered command
  function invoke(name: string, ...args: any[]) {
    const handler = commandHandlers.get(name);
    if (!handler) {
      throw new Error(`Command not registered: ${name}`);
    }
    return handler(...args);
  }

  // ── registration ─────────────────────────────────────────────────

  it('registers all expected commands', () => {
    const expected = [
      'workcenter.refresh',
      'workcenter.createItem',
      'workcenter.acceptToFocus',
      'workcenter.archiveItem',
      'workcenter.completeItem',
      'workcenter.pauseItem',
      'workcenter.resumeItem',
      'workcenter.deleteItem',
      'workcenter.editItem',
      'workcenter.openInBrowser',
      'workcenter.runAction',
      'workcenter.moveUp',
      'workcenter.moveDown',
      'workcenter.focusMoveUp',
      'workcenter.focusMoveDown',
      'workcenter.moveToQueue',
      'workcenter.acceptFromInbox',
      'workcenter.dismissFromInbox',
      'workcenter.acceptFromSources',
      'workcenter.dismissFromSources',
    ];
    for (const cmd of expected) {
      expect(commandHandlers.has(cmd), `missing command: ${cmd}`).toBe(true);
    }
  });

  it('pushes disposables into context.subscriptions', () => {
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  // ── refresh ──────────────────────────────────────────────────────

  describe('workcenter.refresh', () => {
    it('calls providerRegistry.refreshAll and shows progress', async () => {
      await invoke('workcenter.refresh');

      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({ location: vscode.ProgressLocation.Window }),
        expect.any(Function),
      );
      expect(providerRegistry.refreshAll).toHaveBeenCalled();
    });
  });

  // ── createItem ───────────────────────────────────────────────────

  describe('workcenter.createItem', () => {
    it('creates item when user provides a title', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue('My Task');
      await invoke('workcenter.createItem');

      expect(workGraph.createItem).toHaveBeenCalledWith({ title: 'My Task' });
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Created "My Task"',
      );
    });

    it('trims whitespace from the title', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue('  Padded  ');
      await invoke('workcenter.createItem');

      expect(workGraph.createItem).toHaveBeenCalledWith({ title: 'Padded' });
    });

    it('does nothing when user cancels the input box', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);
      await invoke('workcenter.createItem');

      expect(workGraph.createItem).not.toHaveBeenCalled();
    });
  });

  // ── simple state-transition commands ─────────────────────────────

  describe('state-transition commands', () => {
    const transitions: [string, WorkItemState][] = [
      ['workcenter.acceptToFocus', WorkItemState.InProgress],
      ['workcenter.archiveItem', WorkItemState.Archived],
      ['workcenter.completeItem', WorkItemState.Done],
      ['workcenter.pauseItem', WorkItemState.Paused],
      ['workcenter.resumeItem', WorkItemState.InProgress],
      ['workcenter.moveToQueue', WorkItemState.New],
    ];

    for (const [cmd, expectedState] of transitions) {
      it(`${cmd} transitions to ${expectedState}`, () => {
        invoke(cmd, { id: 'wc-42' });
        expect(workGraph.transitionState).toHaveBeenCalledWith('wc-42', expectedState);
      });
    }

    it('shows error when transitionState throws', async () => {
      workGraph.transitionState.mockRejectedValue(new Error('db crash'));
      await invoke('workcenter.archiveItem', { id: 'wc-1' });
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to archive item — db crash',
      );
    });
  });

  // ── editItem ─────────────────────────────────────────────────────

  describe('workcenter.editItem', () => {
    it('opens editor panel when item exists', () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      invoke('workcenter.editItem', { id: item.id });

      expect(workGraph.getItem).toHaveBeenCalledWith(item.id);
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(ctx, workGraph, providerRegistry, item, undefined);
    });

    it('passes provider label when item has providerId', () => {
      const item = createWorkItem({ providerId: 'github' });
      workGraph.getItem.mockReturnValue(item);
      labelCache.get.mockReturnValue('GitHub Issues');

      invoke('workcenter.editItem', { id: item.id });

      expect(labelCache.get).toHaveBeenCalledWith('github');
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(ctx, workGraph, providerRegistry, item, 'GitHub Issues');
    });

    it('does not open editor when item is not found', () => {
      workGraph.getItem.mockReturnValue(undefined);
      invoke('workcenter.editItem', { id: 'missing' });

      expect(workGraph.getItem).toHaveBeenCalledWith('missing');
      expect(WorkItemEditorPanel.open).not.toHaveBeenCalled();
    });
  });

  // ── openInBrowser ────────────────────────────────────────────────

  describe('workcenter.openInBrowser', () => {
    it('opens workItem url when found', async () => {
      const item = createWorkItem({ url: 'https://example.com' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('workcenter.openInBrowser', { id: item.id });

      expect(vscode.env.openExternal).toHaveBeenCalled();
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://example.com/');
    });

    it('falls back to item.url when workItem has no url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('workcenter.openInBrowser', { id: 'wc-1', url: 'https://fallback.com' });

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://fallback.com/');
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('does nothing when neither source has a url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('workcenter.openInBrowser', { id: 'wc-1' });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('does nothing when item not found and tree item has no url', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('workcenter.openInBrowser', { id: 'wc-gone' });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('falls back to tree node url when workItem is not found', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('workcenter.openInBrowser', { id: 'wc-gone', url: 'https://tree-fallback.com' });

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://tree-fallback.com/');
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('shows warning and does not call openExternal for unsafe URL', async () => {
      const item = createWorkItem({ url: 'javascript:alert(1)' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('workcenter.openInBrowser', { id: item.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Cannot open non-web URL: javascript:alert(1)',
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('shows warning and does not call openExternal for data: URL', async () => {
      const item = createWorkItem({ url: 'data:text/html,<h1>hi</h1>' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('workcenter.openInBrowser', { id: item.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open non-web URL'),
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('shows warning and does not call openExternal for file: URL', async () => {
      const item = createWorkItem({ url: 'file:///etc/passwd' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('workcenter.openInBrowser', { id: item.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open non-web URL'),
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('opens url from item without id (Inbox/Sources items)', async () => {
      await invoke('workcenter.openInBrowser', { url: 'https://provider-item.com' });

      expect(workGraph.getItem).not.toHaveBeenCalled();
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://provider-item.com/');
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('rejects unsafe url-only item (Inbox/Sources)', async () => {
      await invoke('workcenter.openInBrowser', { url: 'javascript:alert(1)' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open non-web URL'),
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('shows warning when item has neither id nor url', async () => {
      await invoke('workcenter.openInBrowser', {});

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item to open in the browser.',
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
  });

  // ── runAction ────────────────────────────────────────────────────

  describe('workcenter.runAction', () => {
    it('does nothing when item is not found', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('workcenter.runAction', { id: 'missing' });

      expect(actionRegistry.getActionsFor).not.toHaveBeenCalled();
    });

    it('shows info message when no actions are available', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);
      actionRegistry.getActionsFor.mockReturnValue([]);

      await invoke('workcenter.runAction', { id: item.id });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'No actions available for this item.',
      );
    });

    it('runs the selected action', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      const action = { id: 'act-1', label: 'Deploy', canRun: vi.fn(() => true), run: vi.fn() };
      actionRegistry.getActionsFor.mockReturnValue([action]);
      actionRegistry.getAction.mockReturnValue(action);
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: 'Deploy',
        actionId: 'act-1',
      });

      await invoke('workcenter.runAction', { id: item.id });

      expect(action.run).toHaveBeenCalledWith(item);
    });

    it('does nothing when user cancels the quick pick', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      const action = { id: 'a', label: 'X', canRun: vi.fn(() => true), run: vi.fn() };
      actionRegistry.getActionsFor.mockReturnValue([action]);
      (vscode.window.showQuickPick as Mock).mockResolvedValue(undefined);

      await invoke('workcenter.runAction', { id: item.id });

      expect(action.run).not.toHaveBeenCalled();
    });

    it('shows error message when action throws', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      const action = {
        id: 'fail',
        label: 'Broken',
        canRun: vi.fn(() => true),
        run: vi.fn().mockRejectedValue(new Error('boom')),
      };
      actionRegistry.getActionsFor.mockReturnValue([action]);
      actionRegistry.getAction.mockReturnValue(action);
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: 'Broken',
        actionId: 'fail',
      });

      await invoke('workcenter.runAction', { id: item.id });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Action "Broken" failed — boom',
      );
    });

    it('shows stringified error when action throws a non-Error', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      const action = {
        id: 'fail2',
        label: 'StringErr',
        canRun: vi.fn(() => true),
        run: vi.fn().mockRejectedValue('string error'),
      };
      actionRegistry.getActionsFor.mockReturnValue([action]);
      actionRegistry.getAction.mockReturnValue(action);
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: 'StringErr',
        actionId: 'fail2',
      });

      await invoke('workcenter.runAction', { id: item.id });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Action "StringErr" failed — string error',
      );
    });
  });

  // ── moveUp / moveDown ────────────────────────────────────────────

  describe('workcenter.moveUp', () => {
    it('calls workGraph.moveItem with "up"', () => {
      invoke('workcenter.moveUp', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'up');
    });

    it('shows info message when item is null', () => {
      invoke('workcenter.moveUp', null);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('workcenter.moveUp', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  describe('workcenter.moveDown', () => {
    it('calls workGraph.moveItem with "down"', () => {
      invoke('workcenter.moveDown', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'down');
    });

    it('shows info message when item is undefined', () => {
      invoke('workcenter.moveDown', undefined);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item is null', () => {
      invoke('workcenter.moveDown', null);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('workcenter.moveDown', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  // ── focusMoveUp / focusMoveDown ─────────────────────────────────

  describe('workcenter.focusMoveUp', () => {
    it('calls workGraph.moveItem with "up"', () => {
      invoke('workcenter.focusMoveUp', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'up');
    });

    it('shows info message when item is null', () => {
      invoke('workcenter.focusMoveUp', null);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('workcenter.focusMoveUp', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  describe('workcenter.focusMoveDown', () => {
    it('calls workGraph.moveItem with "down"', () => {
      invoke('workcenter.focusMoveDown', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'down');
    });

    it('shows info message when item is undefined', () => {
      invoke('workcenter.focusMoveDown', undefined);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('workcenter.focusMoveDown', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  // ── acceptFromInbox ──────────────────────────────────────────────

  describe('workcenter.acceptFromInbox', () => {
    it('creates a work item and sets state to accepted', async () => {
      const inboxItem = makeInboxItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('workcenter.acceptFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        { providerId: 'github', externalId: 'ext-1', url: 'https://github.com/org/repo/issues/1' },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('prefixes group to title when group is present', async () => {
      const inboxItem = makeInboxItem({ group: 'org/repo' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('workcenter.acceptFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'org/repo Inbox Issue' },
        expect.any(Object),
      );
    });

    it('does not prefix group when group is empty/whitespace', async () => {
      const inboxItem = makeInboxItem({ group: '  ' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('workcenter.acceptFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        expect.any(Object),
      );
    });

    it('shows info message and sets state when item already accepted', async () => {
      const existing = createWorkItem({ title: 'Already There' });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Item already accepted as "Already There"',
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('shows error when setState fails for existing accepted item', async () => {
      const existing = createWorkItem({ title: 'Already There' });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      stateStore.setState.mockRejectedValue(new Error('write fail'));

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Item already accepted as "Already There"',
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update state for existing accepted item — write fail',
      );
    });

    it('shows error when createItem fails', async () => {
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockRejectedValue(new Error('store error'));

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to accept inbox item — store error',
      );
      expect(stateStore.setState).not.toHaveBeenCalled();
    });

    it('rolls back created item when setState fails', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-1');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update state after accepting item — disk full',
      );
    });

    it('logs error when rollback also fails', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-2' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));
      workGraph.deleteItem.mockRejectedValue(new Error('delete failed'));

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-2');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to roll back created item after setState failure',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update state after accepting item — disk full',
      );
    });
  });

  // ── dismissFromInbox ─────────────────────────────────────────────

  describe('workcenter.dismissFromInbox', () => {
    it('sets state to dismissed', async () => {
      const inboxItem = makeInboxItem();
      await invoke('workcenter.dismissFromInbox', inboxItem);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
    });

    it('shows error when setState fails', async () => {
      stateStore.setState.mockRejectedValue(new Error('io error'));

      await invoke('workcenter.dismissFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to dismiss item — io error',
      );
    });

    it('shows stringified error for non-Error throw', async () => {
      stateStore.setState.mockRejectedValue('raw string');

      await invoke('workcenter.dismissFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to dismiss item — raw string',
      );
    });
  });

  // ── batch acceptFromInbox (multi-select) ──────────────────────────

  describe('workcenter.acceptFromInbox (multi-select)', () => {
    it('batch-accepts multiple items and shows summary', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('workcenter.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to Queue',
      );
    });

    it('skips already-accepted items in batch', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance
        .mockReturnValueOnce(createWorkItem({ title: 'Already There' }))
        .mockReturnValueOnce(undefined);
      workGraph.createItem.mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('workcenter.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to Queue',
      );
    });

    it('rolls back all created items when batch setStates fails', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      stateStore.setStates.mockRejectedValue(new Error('disk full'));

      await invoke('workcenter.acceptFromInbox', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-2');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update states after accepting items — disk full',
      );
    });

    it('continues processing after partial createItem failure', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
        makeInboxItem({ externalId: 'ext-3', title: 'Issue 3' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockRejectedValueOnce(new Error('create failed'))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-3' }));

      await invoke('workcenter.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(3);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-3', state: 'accepted' },
      ]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to accept inbox item "Issue 2"',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to accept 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 of 3 items to Queue',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeInboxItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem());

      await invoke('workcenter.acceptFromInbox', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo', unseenCount: 3 };
      const inboxItem = makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem({ id: 'wc-1' }));

      await invoke('workcenter.acceptFromInbox', providerNode, [providerNode, groupNode, inboxItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
    });

    it('passes group to createItem when batch-accepting items with group', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1', group: 'octocat/repo' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2', group: 'octocat/other' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('workcenter.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'octocat/repo Issue 1' },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-1', group: 'octocat/repo' }),
      );
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'octocat/other Issue 2' },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-2', group: 'octocat/other' }),
      );
    });
  });

  // ── batch dismissFromInbox (multi-select) ─────────────────────────

  describe('workcenter.dismissFromInbox (multi-select)', () => {
    it('batch-dismisses multiple items and shows summary', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1' }),
        makeInboxItem({ externalId: 'ext-2' }),
      ];

      await invoke('workcenter.dismissFromInbox', items[0], items);

      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'dismissed' },
        { providerId: 'github', externalId: 'ext-2', state: 'dismissed' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Dismissed 2 items',
      );
    });

    it('shows error when batch setStates fails', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1' }),
        makeInboxItem({ externalId: 'ext-2' }),
      ];
      stateStore.setStates.mockRejectedValue(new Error('io error'));

      await invoke('workcenter.dismissFromInbox', items[0], items);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to dismiss items — io error',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeInboxItem();

      await invoke('workcenter.dismissFromInbox', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo', unseenCount: 3 };
      const inboxItem = makeInboxItem({ externalId: 'ext-1' });

      await invoke('workcenter.dismissFromInbox', providerNode, [providerNode, groupNode, inboxItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does nothing when selectedItems contains only non-item nodes', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo', unseenCount: 3 };

      await invoke('workcenter.dismissFromInbox', providerNode, [providerNode, groupNode]);

      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('falls back to context item when it is not in the selection', async () => {
      const contextItem = makeInboxItem({ externalId: 'ext-ctx' });
      const selectedItem = makeInboxItem({ externalId: 'ext-other' });

      await invoke('workcenter.dismissFromInbox', contextItem, [selectedItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-ctx', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });
  });

  // ── batch state-transition commands (multi-select) ──────────────────

  describe('batch acceptToFocus (multi-select)', () => {
    it('transitions multiple items to InProgress', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];
      await invoke('workcenter.acceptToFocus', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-3', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 3 items to Focus');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.acceptToFocus', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('continues after partial failure', async () => {
      workGraph.transitionState
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('bad state'))
        .mockResolvedValueOnce(undefined);
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];

      await invoke('workcenter.acceptToFocus', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to transition item wc-2',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to transition 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 2 items to Focus');
    });

    it('does nothing when no items have ids', async () => {
      await invoke('workcenter.acceptToFocus', {}, [{}]);
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });

    it('falls back to context item when it is not in selection', async () => {
      await invoke('workcenter.acceptToFocus', { id: 'wc-ctx' }, [{ id: 'wc-other' }]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-ctx', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch archiveItem (multi-select)', () => {
    it('archives multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('workcenter.archiveItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Archived);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.Archived);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Archived 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.archiveItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Archived);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch completeItem (multi-select)', () => {
    it('completes multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('workcenter.completeItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Done);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.Done);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Completed 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.completeItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Done);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch pauseItem (multi-select)', () => {
    it('pauses multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('workcenter.pauseItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Paused);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.Paused);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Paused 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.pauseItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Paused);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch resumeItem (multi-select)', () => {
    it('resumes multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('workcenter.resumeItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Resumed 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.resumeItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch moveToQueue (multi-select)', () => {
    it('moves multiple items to Queue', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];
      await invoke('workcenter.moveToQueue', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-3', WorkItemState.New);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 3 items to Queue');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.moveToQueue', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.New);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('continues after partial failure', async () => {
      workGraph.transitionState
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('bad state'))
        .mockResolvedValueOnce(undefined);
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];

      await invoke('workcenter.moveToQueue', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to transition item wc-2',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to transition 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 2 items to Queue');
    });

    it('does nothing when no items have ids', async () => {
      await invoke('workcenter.moveToQueue', {}, [{}]);
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });
  });

  // ── deleteItem ──────────────────────────────────────────────────────

  describe('workcenter.deleteItem', () => {
    beforeEach(() => {
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');
    });

    it('deletes a single item after confirmation', async () => {
      await invoke('workcenter.deleteItem', { id: 'wc-1' });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete item? This cannot be undone.',
        { modal: true },
        'Delete',
      );
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
    });

    it('does nothing when user cancels confirmation', async () => {
      (vscode.window.showWarningMessage as Mock).mockResolvedValue(undefined);
      await invoke('workcenter.deleteItem', { id: 'wc-1' });
      expect(workGraph.deleteItem).not.toHaveBeenCalled();
    });

    it('does nothing when item has no id', async () => {
      await invoke('workcenter.deleteItem', {});
      expect(workGraph.deleteItem).not.toHaveBeenCalled();
    });

    it('batch deletes multiple items after confirmation', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];
      await invoke('workcenter.deleteItem', items[0], items);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete 3 items? This cannot be undone.',
        { modal: true },
        'Delete',
      );
      expect(workGraph.deleteItem).toHaveBeenCalledTimes(3);
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-2');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-3');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Deleted 3 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('workcenter.deleteItem', item, [item]);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('continues after partial failure in batch', async () => {
      workGraph.deleteItem
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce(undefined);
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];

      await invoke('workcenter.deleteItem', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to delete item wc-2',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to delete 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Deleted 2 items');
    });

    it('shows error when single delete fails', async () => {
      workGraph.deleteItem.mockRejectedValue(new Error('db error'));
      await invoke('workcenter.deleteItem', { id: 'wc-1' });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to delete item — db error',
      );
    });
  });

  // ── batch acceptFromSources (multi-select) ──────────────────────────

  describe('workcenter.acceptFromSources (multi-select)', () => {
    it('batch-accepts multiple source items', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeSourceItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('workcenter.acceptFromSources', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Accepted 2 items to Queue');
    });

    it('skips already-accepted items in batch', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeSourceItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance
        .mockReturnValueOnce(createWorkItem({ title: 'Already There' }))
        .mockReturnValueOnce(undefined);
      workGraph.createItem.mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('workcenter.acceptFromSources', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
    });

    it('rolls back all created items when batch setStates fails', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeSourceItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      stateStore.setStates.mockRejectedValue(new Error('disk full'));

      await invoke('workcenter.acceptFromSources', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-2');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update states after accepting items — disk full',
      );
    });

    it('continues processing after partial createItem failure', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeSourceItem({ externalId: 'ext-2', title: 'Issue 2' }),
        makeSourceItem({ externalId: 'ext-3', title: 'Issue 3' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockRejectedValueOnce(new Error('create failed'))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-3' }));

      await invoke('workcenter.acceptFromSources', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(3);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-3', state: 'accepted' },
      ]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to accept source item "Issue 2"',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to accept 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 of 3 items to Queue',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeSourceItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem());

      await invoke('workcenter.acceptFromSources', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo' };
      const sourceItem = makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem({ id: 'wc-1' }));

      await invoke('workcenter.acceptFromSources', providerNode, [providerNode, groupNode, sourceItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
    });
  });

  // ── dismissFromSources ──────────────────────────────────────────────

  describe('workcenter.dismissFromSources', () => {
    it('dismisses a single source item', async () => {
      await invoke('workcenter.dismissFromSources', makeSourceItem());

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'dismissed');
    });

    it('shows error when single dismiss fails', async () => {
      stateStore.setState.mockRejectedValue(new Error('io error'));

      await invoke('workcenter.dismissFromSources', makeSourceItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to dismiss item — io error',
      );
    });

    it('batch-dismisses multiple source items', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1' }),
        makeSourceItem({ externalId: 'ext-2' }),
      ];

      await invoke('workcenter.dismissFromSources', items[0], items);

      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'dismissed' },
        { providerId: 'github', externalId: 'ext-2', state: 'dismissed' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Dismissed 2 items');
    });

    it('shows error when batch setStates fails', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1' }),
        makeSourceItem({ externalId: 'ext-2' }),
      ];
      stateStore.setStates.mockRejectedValue(new Error('io error'));

      await invoke('workcenter.dismissFromSources', items[0], items);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to dismiss items — io error',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeSourceItem();

      await invoke('workcenter.dismissFromSources', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo' };
      const sourceItem = makeSourceItem({ externalId: 'ext-1' });

      await invoke('workcenter.dismissFromSources', providerNode, [providerNode, groupNode, sourceItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does nothing when selectedItems contains only non-item nodes', async () => {
      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo' };

      await invoke('workcenter.dismissFromSources', providerNode, [providerNode, groupNode]);

      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('falls back to context item when it is not in the selection', async () => {
      const contextItem = makeSourceItem({ externalId: 'ext-ctx' });
      const selectedItem = makeSourceItem({ externalId: 'ext-other' });

      await invoke('workcenter.dismissFromSources', contextItem, [selectedItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-ctx', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });
  });

  // ── acceptFromSources────────────────────────────────────────────

  describe('workcenter.acceptFromSources', () => {
    it('creates a work item and sets state to accepted for new item', async () => {
      const sourceItem = makeSourceItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('workcenter.acceptFromSources', sourceItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Source Issue' },
        { providerId: 'github', externalId: 'ext-2', url: 'https://github.com/org/repo/issues/2' },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
    });

    it('sets state to accepted without creating when item already exists', async () => {
      const existing = createWorkItem({ title: 'Existing' });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('workcenter.acceptFromSources', makeSourceItem());

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Item already accepted as "Existing"',
      );
    });

    it('shows error when setState fails for existing item', async () => {
      const existing = createWorkItem({ title: 'Existing' });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      stateStore.setState.mockRejectedValue(new Error('write fail'));

      await invoke('workcenter.acceptFromSources', makeSourceItem());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Item already accepted as "Existing"',
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update state for existing item — write fail',
      );
    });

    it('shows error when createItem fails for new item', async () => {
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockRejectedValue(new Error('store error'));

      await invoke('workcenter.acceptFromSources', makeSourceItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to accept sources item — store error',
      );
    });

    it('prefixes group to title for source items with group', async () => {
      const sourceItem = makeSourceItem({ group: 'myorg/myrepo' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('workcenter.acceptFromSources', sourceItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'myorg/myrepo Source Issue' },
        expect.any(Object),
      );
    });

    it('rolls back created item when setState fails for new item', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-3' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));

      await invoke('workcenter.acceptFromSources', makeSourceItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-3');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update state after accepting item — disk full',
      );
    });

    it('logs error when rollback also fails for new item', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-4' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));
      workGraph.deleteItem.mockRejectedValue(new Error('delete failed'));

      await invoke('workcenter.acceptFromSources', makeSourceItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-4');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to roll back created item after setState failure',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to update state after accepting item — disk full',
      );
    });
  });
});

// ── isSafeUrl (unit tests) ───────────────────────────────────────────

describe('isSafeUrl', () => {
  it('accepts http:// URLs', () => {
    const result = isSafeUrl('http://example.com');
    expect(result).not.toBeNull();
    expect(result!.href).toBe('http://example.com/');
  });

  it('accepts https:// URLs', () => {
    const result = isSafeUrl('https://example.com');
    expect(result).not.toBeNull();
    expect(result!.href).toBe('https://example.com/');
  });

  it('rejects data: URLs', () => {
    expect(isSafeUrl('data:text/html,<h1>hi</h1>')).toBeNull();
  });

  it('rejects file: URLs', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(isSafeUrl('not-a-url')).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(isSafeUrl('')).toBeNull();
  });
});

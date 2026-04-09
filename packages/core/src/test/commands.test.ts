import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { registerCommands } from '../commands/commands';
import type { WorkGraph } from '../services/workGraph';
import type { ActionRegistry } from '../services/actionRegistry';
import type { DiscoveredStateStore } from '../storage/discoveredStateStore';
import type { InboxItem } from '../views/inboxTreeProvider';
import type { SourceItemNode } from '../views/sourcesTreeProvider';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';

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
  'transitionState' | 'getItem' | 'createItem' | 'findItemByProvenance' | 'moveItem'
>;

function createMockWorkGraph(): { [K in keyof UsedWorkGraphMethods]: Mock } {
  return {
    transitionState: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(async () => createWorkItem()),
    findItemByProvenance: vi.fn(),
    moveItem: vi.fn(),
  };
}

type UsedActionRegistryMethods = Pick<ActionRegistry, 'getActionsFor' | 'getAction'>;

function createMockActionRegistry(): { [K in keyof UsedActionRegistryMethods]: Mock } {
  return {
    getActionsFor: vi.fn(() => []),
    getAction: vi.fn(),
  };
}

type UsedStateStoreMethods = Pick<DiscoveredStateStore, 'setState'>;

function createMockStateStore(): { [K in keyof UsedStateStoreMethods]: Mock } {
  return {
    setState: vi.fn(),
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
  let ctx: vscode.ExtensionContext;

  beforeEach(() => {
    vi.restoreAllMocks();

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
    ctx = createMockContext();

    registerCommands(ctx, workGraph as any, actionRegistry as any, stateStore as any);
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
      'workcenter.createItem',
      'workcenter.acceptToFocus',
      'workcenter.archiveItem',
      'workcenter.completeItem',
      'workcenter.pauseItem',
      'workcenter.resumeItem',
      'workcenter.editItem',
      'workcenter.openInBrowser',
      'workcenter.runAction',
      'workcenter.moveUp',
      'workcenter.moveDown',
      'workcenter.acceptFromInbox',
      'workcenter.dismissFromInbox',
      'workcenter.acceptFromSources',
    ];
    for (const cmd of expected) {
      expect(commandHandlers.has(cmd), `missing command: ${cmd}`).toBe(true);
    }
  });

  it('pushes disposables into context.subscriptions', () => {
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
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
    ];

    for (const [cmd, expectedState] of transitions) {
      it(`${cmd} transitions to ${expectedState}`, () => {
        invoke(cmd, { id: 'wc-42' });
        expect(workGraph.transitionState).toHaveBeenCalledWith('wc-42', expectedState);
      });
    }
  });

  // ── editItem ─────────────────────────────────────────────────────

  describe('workcenter.editItem', () => {
    it('opens editor panel when item exists', () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      invoke('workcenter.editItem', { id: item.id });

      expect(workGraph.getItem).toHaveBeenCalledWith(item.id);
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(ctx, workGraph, item);
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
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://example.com');
    });

    it('falls back to item.url when workItem has no url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('workcenter.openInBrowser', { id: 'wc-1', url: 'https://fallback.com' });

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://fallback.com');
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

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://tree-fallback.com');
      expect(vscode.env.openExternal).toHaveBeenCalled();
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

    it('shows info message when item already accepted', async () => {
      const existing = createWorkItem({ title: 'Already There' });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Item already accepted as "Already There"',
      );
    });

    it('shows error when setState fails', async () => {
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      stateStore.setState.mockRejectedValue(new Error('disk full'));

      await invoke('workcenter.acceptFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Failed to accept inbox item — disk full',
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

  // ── acceptFromSources ────────────────────────────────────────────

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
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commands, window, env, Uri } from 'vscode';
import { registerCommands } from '../commands/commands';
import { WorkGraph } from '../services/workGraph';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { ITaskStore } from '../storage/taskStore';
import type { InboxItem } from '../views/inboxTreeProvider';
import type { SourceItemNode } from '../views/sourcesTreeProvider';

vi.mock('../views/workItemEditorPanel', () => ({
  WorkItemEditorPanel: { open: vi.fn() },
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createMockStateStore() {
  return {
    setState: vi.fn(async () => {}),
    getState: vi.fn(() => 'unseen' as const),
    load: vi.fn(async () => {}),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function createMockContext() {
  return {
    subscriptions: [] as any[],
    globalStorageUri: { fsPath: '/mock/storage' },
  } as any;
}

function getCommandHandler(commandId: string): Function {
  const calls = vi.mocked(commands.registerCommand).mock.calls;
  const match = calls.find((c) => c[0] === commandId);
  if (!match) {
    throw new Error(`Command not registered: ${commandId}`);
  }
  return match[1] as Function;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerCommands', () => {
  let workGraph: WorkGraph;
  let actionRegistry: ActionRegistry;
  let stateStore: ReturnType<typeof createMockStateStore>;
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const store = createMockStore();
    workGraph = new WorkGraph(store);
    await workGraph.load();
    actionRegistry = new ActionRegistry();
    stateStore = createMockStateStore();
    mockContext = createMockContext();

    registerCommands(mockContext, workGraph, actionRegistry, stateStore as any);
  });

  // -----------------------------------------------------------------------
  // workcenter.createItem
  // -----------------------------------------------------------------------

  describe('workcenter.createItem', () => {
    it('creates item when user provides a title', async () => {
      vi.mocked(window.showInputBox).mockResolvedValueOnce('Fix login bug');
      const handler = getCommandHandler('workcenter.createItem');
      await handler();

      const items = workGraph.getAll();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Fix login bug');
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Fix login bug'),
      );
    });

    it('does nothing when user cancels input', async () => {
      vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined);
      const handler = getCommandHandler('workcenter.createItem');
      await handler();

      expect(workGraph.getAll()).toHaveLength(0);
      expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('trims whitespace from title', async () => {
      vi.mocked(window.showInputBox).mockResolvedValueOnce('  spaced  ');
      const handler = getCommandHandler('workcenter.createItem');
      await handler();

      expect(workGraph.getAll()[0].title).toBe('spaced');
    });
  });

  // -----------------------------------------------------------------------
  // State transition commands
  // -----------------------------------------------------------------------

  describe('state transition commands', () => {
    let item: WorkItem;

    beforeEach(async () => {
      item = await workGraph.createItem({ title: 'Test item' });
    });

    it('acceptToFocus transitions to InProgress', async () => {
      const handler = getCommandHandler('workcenter.acceptToFocus');
      await handler({ id: item.id });
      expect(workGraph.getItem(item.id)!.state).toBe(WorkItemState.InProgress);
    });

    it('archiveItem transitions to Archived', async () => {
      const handler = getCommandHandler('workcenter.archiveItem');
      await handler({ id: item.id });
      expect(workGraph.getItem(item.id)!.state).toBe(WorkItemState.Archived);
    });

    it('completeItem transitions to Done', async () => {
      const handler = getCommandHandler('workcenter.completeItem');
      await handler({ id: item.id });
      expect(workGraph.getItem(item.id)!.state).toBe(WorkItemState.Done);
    });

    it('blockItem transitions to Blocked', async () => {
      await workGraph.transitionState(item.id, WorkItemState.InProgress);
      const handler = getCommandHandler('workcenter.blockItem');
      await handler({ id: item.id });
      expect(workGraph.getItem(item.id)!.state).toBe(WorkItemState.Blocked);
    });

    it('unblockItem transitions to InProgress', async () => {
      await workGraph.transitionState(item.id, WorkItemState.InProgress);
      await workGraph.transitionState(item.id, WorkItemState.Blocked);
      const handler = getCommandHandler('workcenter.unblockItem');
      await handler({ id: item.id });
      expect(workGraph.getItem(item.id)!.state).toBe(WorkItemState.InProgress);
    });

    it('markWaitingOn transitions to WaitingOn', async () => {
      await workGraph.transitionState(item.id, WorkItemState.InProgress);
      const handler = getCommandHandler('workcenter.markWaitingOn');
      await handler({ id: item.id });
      expect(workGraph.getItem(item.id)!.state).toBe(WorkItemState.WaitingOn);
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.editItem
  // -----------------------------------------------------------------------

  describe('workcenter.editItem', () => {
    it('opens editor panel for existing item', async () => {
      const item = await workGraph.createItem({ title: 'Edit me' });
      const handler = getCommandHandler('workcenter.editItem');
      handler({ id: item.id });

      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(
        mockContext,
        workGraph,
        expect.objectContaining({ id: item.id, title: 'Edit me' }),
      );
    });

    it('does nothing for nonexistent item', () => {
      const handler = getCommandHandler('workcenter.editItem');
      handler({ id: 'nonexistent' });
      expect(WorkItemEditorPanel.open).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.openInBrowser
  // -----------------------------------------------------------------------

  describe('workcenter.openInBrowser', () => {
    it('opens workItem.url when available', async () => {
      const item = await workGraph.createItem(
        { title: 'Has url' },
        { providerId: 'gh', externalId: '1', url: 'https://github.com/issue/1' },
      );
      const handler = getCommandHandler('workcenter.openInBrowser');
      handler({ id: item.id });

      expect(Uri.parse).toHaveBeenCalledWith('https://github.com/issue/1');
      expect(env.openExternal).toHaveBeenCalled();
    });

    it('falls back to item.url when workItem has no url', async () => {
      const item = await workGraph.createItem({ title: 'No provider url' });
      const handler = getCommandHandler('workcenter.openInBrowser');
      handler({ id: item.id, url: 'https://fallback.com' });

      expect(Uri.parse).toHaveBeenCalledWith('https://fallback.com');
      expect(env.openExternal).toHaveBeenCalled();
    });

    it('uses item.url from argument when workItem has no url', () => {
      const handler = getCommandHandler('workcenter.openInBrowser');
      handler({ id: 'nonexistent', url: 'https://fallback.com' });

      expect(Uri.parse).toHaveBeenCalledWith('https://fallback.com');
      expect(env.openExternal).toHaveBeenCalled();
    });

    it('does nothing when no url exists', async () => {
      const item = await workGraph.createItem({ title: 'No url at all' });
      const handler = getCommandHandler('workcenter.openInBrowser');
      handler({ id: item.id });
      expect(env.openExternal).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.runAction
  // -----------------------------------------------------------------------

  describe('workcenter.runAction', () => {
    it('shows info message when no actions available', async () => {
      const item = await workGraph.createItem({ title: 'No actions' });
      const handler = getCommandHandler('workcenter.runAction');
      await handler({ id: item.id });

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'No actions available for this item.',
      );
    });

    it('does nothing when work item not found', async () => {
      const handler = getCommandHandler('workcenter.runAction');
      await handler({ id: 'nonexistent' });

      expect(window.showQuickPick).not.toHaveBeenCalled();
      expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('runs selected action', async () => {
      const item = await workGraph.createItem({ title: 'Actionable' });
      const mockAction = {
        id: 'test-action',
        label: 'Test Action',
        canRun: () => true,
        run: vi.fn(async () => {}),
      };
      actionRegistry.register(mockAction);

      vi.mocked(window.showQuickPick).mockResolvedValueOnce({
        label: 'Test Action',
        actionId: 'test-action',
      } as any);

      const handler = getCommandHandler('workcenter.runAction');
      await handler({ id: item.id });

      expect(window.showQuickPick).toHaveBeenCalled();
      expect(mockAction.run).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
    });

    it('does nothing when user cancels quick pick', async () => {
      const item = await workGraph.createItem({ title: 'Cancel action' });
      const mockAction = {
        id: 'action2',
        label: 'Action',
        canRun: () => true,
        run: vi.fn(async () => {}),
      };
      actionRegistry.register(mockAction);

      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);

      const handler = getCommandHandler('workcenter.runAction');
      await handler({ id: item.id });

      expect(mockAction.run).not.toHaveBeenCalled();
    });

    it('shows error message when action throws', async () => {
      const item = await workGraph.createItem({ title: 'Failing action' });
      const mockAction = {
        id: 'fail-action',
        label: 'Fail',
        canRun: () => true,
        run: vi.fn(async () => { throw new Error('boom'); }),
      };
      actionRegistry.register(mockAction);

      vi.mocked(window.showQuickPick).mockResolvedValueOnce({
        label: 'Fail',
        actionId: 'fail-action',
      } as any);

      const handler = getCommandHandler('workcenter.runAction');
      await handler({ id: item.id });

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('boom'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.moveUp / moveDown
  // -----------------------------------------------------------------------

  describe('workcenter.moveUp / moveDown', () => {
    it('moveUp shows info message when no item selected', () => {
      const handler = getCommandHandler('workcenter.moveUp');
      handler(undefined);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
    });

    it('moveDown shows info message when no item selected', () => {
      const handler = getCommandHandler('workcenter.moveDown');
      handler(null);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
    });

    it('moveUp shows info message when item has no id', () => {
      const handler = getCommandHandler('workcenter.moveUp');
      handler({});
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Select an item in the Queue to move.',
      );
    });

    it('moveUp calls workGraph.moveItem with up', async () => {
      const item1 = await workGraph.createItem({ title: 'First' });
      const item2 = await workGraph.createItem({ title: 'Second' });
      const handler = getCommandHandler('workcenter.moveUp');
      await handler({ id: item2.id });

      const updated = workGraph.getItem(item2.id)!;
      const other = workGraph.getItem(item1.id)!;
      expect(updated.sortOrder).toBeLessThan(other.sortOrder!);
    });

    it('moveDown calls workGraph.moveItem with down', async () => {
      const item1 = await workGraph.createItem({ title: 'First' });
      const item2 = await workGraph.createItem({ title: 'Second' });
      const handler = getCommandHandler('workcenter.moveDown');
      await handler({ id: item1.id });

      const updated = workGraph.getItem(item1.id)!;
      const other = workGraph.getItem(item2.id)!;
      expect(updated.sortOrder).toBeGreaterThan(other.sortOrder!);
    });

    it('moveUp on first item is a no-op', async () => {
      const item1 = await workGraph.createItem({ title: 'First' });
      await workGraph.createItem({ title: 'Second' });
      const originalOrder = workGraph.getItem(item1.id)!.sortOrder;
      const handler = getCommandHandler('workcenter.moveUp');
      await handler({ id: item1.id });

      expect(workGraph.getItem(item1.id)!.sortOrder).toBe(originalOrder);
    });

    it('moveDown on last item is a no-op', async () => {
      await workGraph.createItem({ title: 'First' });
      const item2 = await workGraph.createItem({ title: 'Second' });
      const originalOrder = workGraph.getItem(item2.id)!.sortOrder;
      const handler = getCommandHandler('workcenter.moveDown');
      await handler({ id: item2.id });

      expect(workGraph.getItem(item2.id)!.sortOrder).toBe(originalOrder);
    });

    it('moveUp with a single item is a no-op', async () => {
      const item = await workGraph.createItem({ title: 'Only' });
      const originalOrder = workGraph.getItem(item.id)!.sortOrder;
      const handler = getCommandHandler('workcenter.moveUp');
      await handler({ id: item.id });

      expect(workGraph.getItem(item.id)!.sortOrder).toBe(originalOrder);
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.acceptFromInbox
  // -----------------------------------------------------------------------

  describe('workcenter.acceptFromInbox', () => {
    const inboxItem: InboxItem = {
      kind: 'item',
      providerId: 'github',
      externalId: '42',
      title: 'Fix bug',
      url: 'https://github.com/issue/42',
    };

    it('creates work item and sets state to accepted', async () => {
      const handler = getCommandHandler('workcenter.acceptFromInbox');
      await handler(inboxItem);

      const items = workGraph.getAll();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Fix bug');
      expect(stateStore.setState).toHaveBeenCalledWith('github', '42', 'accepted');
    });

    it('shows info message when item already accepted', async () => {
      await workGraph.createItem(
        { title: 'Fix bug' },
        { providerId: 'github', externalId: '42', url: 'https://github.com/issue/42' },
      );

      const handler = getCommandHandler('workcenter.acceptFromInbox');
      await handler(inboxItem);

      expect(workGraph.getAll()).toHaveLength(1);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('already accepted'),
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', '42', 'accepted');
    });

    it('prefixes title with group when group is present', async () => {
      const groupedItem: InboxItem = {
        ...inboxItem,
        group: 'myorg/myrepo',
      };
      const handler = getCommandHandler('workcenter.acceptFromInbox');
      await handler(groupedItem);

      expect(workGraph.getAll()[0].title).toBe('myorg/myrepo Fix bug');
    });

    it('shows error when setState fails', async () => {
      stateStore.setState.mockRejectedValueOnce(new Error('write failed'));
      const handler = getCommandHandler('workcenter.acceptFromInbox');
      await handler(inboxItem);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('write failed'),
      );
    });

    it('shows error when createItem fails', async () => {
      const failStore = createMockStore();
      failStore.save = vi.fn(async () => { throw new Error('save failed'); });
      const failGraph = new WorkGraph(failStore);
      await failGraph.load();

      vi.mocked(commands.registerCommand).mockClear();
      const ctx = createMockContext();
      registerCommands(ctx, failGraph, actionRegistry, stateStore as any);

      const newHandler = getCommandHandler('workcenter.acceptFromInbox');
      await newHandler(inboxItem);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('save failed'),
      );
      expect(failGraph.getAll()).toHaveLength(0);
      expect(stateStore.setState).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.dismissFromInbox
  // -----------------------------------------------------------------------

  describe('workcenter.dismissFromInbox', () => {
    const inboxItem: InboxItem = {
      kind: 'item',
      providerId: 'github',
      externalId: '99',
      title: 'Not relevant',
    };

    it('sets state to dismissed', async () => {
      const handler = getCommandHandler('workcenter.dismissFromInbox');
      await handler(inboxItem);

      expect(stateStore.setState).toHaveBeenCalledWith('github', '99', 'dismissed');
    });

    it('shows error when setState fails', async () => {
      stateStore.setState.mockRejectedValueOnce(new Error('disk full'));
      const handler = getCommandHandler('workcenter.dismissFromInbox');
      await handler(inboxItem);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('disk full'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // workcenter.acceptFromSources
  // -----------------------------------------------------------------------

  describe('workcenter.acceptFromSources', () => {
    const sourceItem: SourceItemNode = {
      kind: 'item',
      providerId: 'github',
      externalId: '77',
      title: 'Feature request',
      url: 'https://github.com/issue/77',
    };

    it('creates work item and sets state to accepted', async () => {
      const handler = getCommandHandler('workcenter.acceptFromSources');
      await handler(sourceItem);

      const items = workGraph.getAll();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Feature request');
      expect(stateStore.setState).toHaveBeenCalledWith('github', '77', 'accepted');
    });

    it('sets state and shows info when item already exists', async () => {
      await workGraph.createItem(
        { title: 'Feature request' },
        { providerId: 'github', externalId: '77', url: 'https://github.com/issue/77' },
      );

      const handler = getCommandHandler('workcenter.acceptFromSources');
      await handler(sourceItem);

      expect(workGraph.getAll()).toHaveLength(1);
      expect(stateStore.setState).toHaveBeenCalledWith('github', '77', 'accepted');
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('already accepted'),
      );
    });

    it('prefixes title with group when group is present', async () => {
      const groupedItem: SourceItemNode = {
        ...sourceItem,
        group: 'org/repo',
      };
      const handler = getCommandHandler('workcenter.acceptFromSources');
      await handler(groupedItem);

      expect(workGraph.getAll()[0].title).toBe('org/repo Feature request');
    });

    it('shows error when createItem fails', async () => {
      // Create a store that fails
      const failStore = createMockStore();
      failStore.save = vi.fn(async () => { throw new Error('save failed'); });
      const failGraph = new WorkGraph(failStore);
      await failGraph.load();

      // Re-register commands with failing graph
      vi.mocked(commands.registerCommand).mockClear();
      const ctx = createMockContext();
      registerCommands(ctx, failGraph, actionRegistry, stateStore as any);

      const newHandler = getCommandHandler('workcenter.acceptFromSources');
      await newHandler(sourceItem);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('save failed'),
      );
      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(failGraph.getAll()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // subscriptions
  // -----------------------------------------------------------------------

  describe('subscriptions', () => {
    it('pushes all disposables to context.subscriptions', () => {
      const registeredCount = vi.mocked(commands.registerCommand).mock.calls.length;
      expect(mockContext.subscriptions).toHaveLength(registeredCount);
    });
  });
});

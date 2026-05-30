import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { type RecoverableError } from '@devdocket/shared';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { registerCommands } from '../commands/commands';
import { isSafeUrl } from '../utils/url';
import type { WorkGraph } from '../services/workGraph';
import type { ActionRegistry } from '../services/actionRegistry';
import type { ProviderRegistry } from '../services/providerRegistry';
import type { InboxStateStore } from '../storage/inboxStateStore';
import type { ProviderLabelCache } from '../storage/providerLabelCache';
import type { WatcherRegistry } from '../services/watcherRegistry';
import type { PRWatcherRegistry } from '../services/prWatcherRegistry';
import type { WatcherService } from '../services/watcherService';
import type { InboxItem, InboxProviderNode, InboxGroupNode, SourceItemNode, SourceProviderNode, SourceGroupNode } from '../commands/commandItemTypes';
import { PanelManager, WorkItemEditorPanel, type WorkItemEditorPanelDependencies } from '../views/workItemEditorPanel';
import { IncomingPreviewPanelManager } from '../views/incomingPreviewPanel';
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

function makeRecoverableError(overrides: Partial<RecoverableError> = {}): RecoverableError {
  const error = new Error('Recoverable error') as RecoverableError;
  Object.assign(error, {
    recoverable: true as const,
    ...overrides,
  });
  return error;
}

function selectErrorAction(label: string): void {
  (vscode.window.showErrorMessage as Mock).mockImplementationOnce(async (_message: string, ...items: any[]) =>
    items.find(item => (typeof item === 'string' ? item : item.title) === label),
  );
}

type UsedWorkGraphMethods = Pick<
  WorkGraph,
  'transitionState' | 'resumeItem' | 'getItem' | 'createItem' | 'findItemByProvenance' | 'acceptManyFromInbox' | 'moveItem' | 'deleteItem' | 'clearOldHistory' | 'addActivity'
>;

function createMockWorkGraph(): { [K in keyof UsedWorkGraphMethods]: Mock } {
  const graph = {
    transitionState: vi.fn(),
    resumeItem: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(async () => createWorkItem()),
    findItemByProvenance: vi.fn(),
    acceptManyFromInbox: vi.fn(),
    moveItem: vi.fn(),
    deleteItem: vi.fn(),
    clearOldHistory: vi.fn(async () => ({ deleted: 0, failed: 0 })),
    addActivity: vi.fn(),
  };
  graph.acceptManyFromInbox.mockImplementation(async (items: InboxItem[]) => {
    const accepted: Array<{ input: InboxItem; item: WorkItem; created: boolean; reopenedFrom?: WorkItemState }> = [];
    const failures: Array<{ input: InboxItem; error: unknown }> = [];
    const createdItemIds: string[] = [];
    const reopenedItems: Array<{ id: string; originalState: WorkItemState }> = [];

    for (const item of items) {
      const existing = graph.findItemByProvenance(item.providerId, item.externalId);
      if (existing) {
        if (existing.state === WorkItemState.Done || existing.state === WorkItemState.Archived) {
          const originalState = existing.state;
          try {
            await graph.transitionState(existing.id, WorkItemState.New);
            reopenedItems.push({ id: existing.id, originalState });
            accepted.push({ input: item, item: { ...existing, state: WorkItemState.New }, created: false, reopenedFrom: originalState });
          } catch (error: unknown) {
            failures.push({ input: item, error });
          }
          continue;
        }
        accepted.push({ input: item, item: existing, created: false });
        continue;
      }

      try {
        const created = await graph.createItem(
          { title: item.title, description: item.description },
          { providerId: item.providerId, externalId: item.externalId, itemType: item.itemType, url: item.url, group: item.group?.trim() || undefined },
        );
        createdItemIds.push(created.id);
        accepted.push({ input: item, item: created, created: true });
      } catch (error: unknown) {
        failures.push({ input: item, error });
      }
    }

    return { accepted, failures, createdItemIds, reopenedItems };
  });
  return graph;
}

type UsedActionRegistryMethods = Pick<ActionRegistry, 'getActionsFor' | 'getAction'>;

function createMockActionRegistry(): { [K in keyof UsedActionRegistryMethods]: Mock } {
  return {
    getActionsFor: vi.fn(() => []),
    getAction: vi.fn(),
  };
}

type UsedStateStoreMethods = Pick<InboxStateStore, 'setState' | 'setStates' | 'getState'>;

function createMockStateStore(): { [K in keyof UsedStateStoreMethods]: Mock } {
  return {
    setState: vi.fn(),
    setStates: vi.fn(),
    getState: vi.fn(),
  };
}

type UsedProviderRegistryMethods = Pick<ProviderRegistry, 'refreshAll' | 'resolveUrl' | 'getAllProviderItems' | 'getProviderItems' | 'getProviderLabel' | 'getProviders' | 'registerSyntheticProviderItem'>;

function createMockProviderRegistry(): { [K in keyof UsedProviderRegistryMethods]: Mock } {
  return {
    refreshAll: vi.fn().mockResolvedValue(undefined),
    resolveUrl: vi.fn().mockResolvedValue(undefined),
    getAllProviderItems: vi.fn().mockReturnValue(new Map()),
    getProviderItems: vi.fn().mockReturnValue([]),
    getProviderLabel: vi.fn((providerId: string) => providerId),
    getProviders: vi.fn().mockReturnValue([
      { id: 'github', label: 'GitHub' },
      { id: 'ado', label: 'Azure DevOps' },
    ]),
    registerSyntheticProviderItem: vi.fn(),
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
  let watchPanelProvider: { open: Mock };
  let editorPanelDependencies: WorkItemEditorPanelDependencies;
  let incomingPreviewPanelManager: IncomingPreviewPanelManager;
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
    watchPanelProvider = { open: vi.fn() };
    editorPanelDependencies = {
      panelManager: new PanelManager(),
      actionRegistry: actionRegistry as any,
      stateStore: stateStore as any,
    };
    incomingPreviewPanelManager = new IncomingPreviewPanelManager();
    ctx = createMockContext();

    registerCommands(
      ctx,
      workGraph as any,
      actionRegistry as any,
      stateStore as any,
      { has: () => false, add: vi.fn().mockResolvedValue(true) } as any,
      providerRegistry as any,
      labelCache as any,
      {} as WatcherRegistry,
      {} as PRWatcherRegistry,
      {} as WatcherService,
      watchPanelProvider as any,
      editorPanelDependencies,
      incomingPreviewPanelManager,
      vi.fn(),
      { onDidChange: vi.fn(() => ({ dispose: vi.fn() })), resolve: vi.fn().mockResolvedValue(undefined) } as any,
    );
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
      'devdocket.refresh',
      'devdocket.createItem',
      'devdocket.acceptToFocus',
      'devdocket.archiveItem',
      'devdocket.completeItem',
      'devdocket.pauseItem',
      'devdocket.resumeItem',
      'devdocket.deleteItem',
      'devdocket.editItem',
      'devdocket.openInBrowser',
      'devdocket.copyUrl',
      'devdocket.openWorktreeForItem',
      'devdocket.runAction',
      'devdocket.moveUp',
      'devdocket.moveDown',
      'devdocket.focusMoveUp',
      'devdocket.focusMoveDown',
      'devdocket.moveToQueue',
      'devdocket.acceptFromInbox',
      'devdocket.acceptToFocusFromInbox',
      'devdocket.dismissFromInbox',
      'devdocket.acceptAllFromInbox',
      'devdocket.acceptAllToFocusFromInbox',
      'devdocket.dismissAllFromInbox',
      'devdocket.acceptFromSources',
      'devdocket.dismissFromSources',
      'devdocket.createItemFromUrl',
      'devdocket.clearHistory',
      'devdocket.addActivity',
      'devdocket.watchUrl',
      'devdocket.showWatchesQuickPick',
      'devdocket.browseProviderExtensions',
    ];
    for (const cmd of expected) {
      expect(commandHandlers.has(cmd), `missing command: ${cmd}`).toBe(true);
    }
  });

  it('pushes disposables into context.subscriptions', () => {
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  // ── refresh ──────────────────────────────────────────────────────

  describe('devdocket.refresh', () => {
    it('calls providerRegistry.refreshAll with cancellable notification progress', async () => {
      const report = vi.fn();
      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      (vscode.window.withProgress as Mock).mockImplementationOnce((_options: any, task: any) =>
        task({ report }, token),
      );

      await invoke('devdocket.refresh');

      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          location: vscode.ProgressLocation.Notification,
          title: 'DevDocket: Refresh',
          cancellable: true,
        }),
        expect.any(Function),
      );
      expect(report).toHaveBeenCalledWith({
        message: 'Refreshing… 0/2 providers done — waiting on GitHub and Azure DevOps',
      });
      expect(providerRegistry.refreshAll).toHaveBeenCalledWith(token, expect.any(Function));

      const onProgress = providerRegistry.refreshAll.mock.calls[0][1];
      onProgress({
        providerId: 'github',
        providerLabel: 'GitHub',
        completed: 1,
        total: 2,
        pendingProviders: [{ id: 'ado', label: 'Azure DevOps' }],
        outcome: 'success',
      });
      expect(report).toHaveBeenCalledWith({
        message: 'GitHub refreshed — Refreshing… 1/2 providers done — waiting on Azure DevOps',
      });
    });

    it('uses singular provider wording for one registered provider', async () => {
      const report = vi.fn();
      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      providerRegistry.getProviders.mockReturnValueOnce([{ id: 'github', label: 'GitHub' }] as any);
      (vscode.window.withProgress as Mock).mockImplementationOnce((_options: any, task: any) =>
        task({ report }, token),
      );

      await invoke('devdocket.refresh');

      expect(report).toHaveBeenCalledWith({
        message: 'Refreshing… 0/1 provider done — waiting on GitHub',
      });
    });
  });

  describe('devdocket.showWatchesQuickPick', () => {
    it('opens the watch panel provider', async () => {
      await invoke('devdocket.showWatchesQuickPick');

      expect(watchPanelProvider.open).toHaveBeenCalled();
    });
  });

  // ── browseProviderExtensions ─────────────────────────────────────

  describe('devdocket.browseProviderExtensions', () => {
    it('opens the Extensions view filtered to the devdocket publisher', async () => {
      await invoke('devdocket.browseProviderExtensions');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.extensions.search',
        '@publisher:"devdocket"',
      );
    });
  });

  // ── createItem ───────────────────────────────────────────────────

  describe('devdocket.createItem', () => {
    it('creates item when user provides a title and opens the editor', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue('My Task');
      const createdItem = createWorkItem({ id: 'wc-created', title: 'My Task' });
      workGraph.createItem.mockResolvedValue(createdItem);

      await invoke('devdocket.createItem');

      expect(workGraph.createItem).toHaveBeenCalledWith({ title: 'My Task' });
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(
        ctx,
        workGraph,
        providerRegistry,
        createdItem,
        editorPanelDependencies,
        undefined,
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Created "My Task"',
      );
    });

    it('trims whitespace from the title', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue('  Padded  ');
      workGraph.createItem.mockResolvedValue(createWorkItem({ id: 'wc-trimmed', title: 'Padded' }));

      await invoke('devdocket.createItem');

      expect(workGraph.createItem).toHaveBeenCalledWith({ title: 'Padded' });
    });

    it('does nothing when user cancels the input box', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);
      await invoke('devdocket.createItem');

      expect(workGraph.createItem).not.toHaveBeenCalled();
    });
  });

  // ── createItemFromUrl ───────────────────────────────────────────

  describe('devdocket.createItemFromUrl', () => {
    const fakeDetails = {
      providerId: 'github-pr-reviews',
      item: {
        title: '#42: Fix bug',
        description: 'Description',
        url: 'https://github.com/owner/repo/pull/42',
        externalId: 'owner/repo#42',
        group: 'owner/repo',
        itemType: 'pr',
        capabilities: {
          gitWork: vi.fn(async () => ({
            kind: 'pr',
            cloneUrl: 'https://github.com/owner/repo.git',
            ref: 'feature/topic',
            repoLabel: 'owner/repo',
          })),
        },
      },
    };

    beforeEach(() => {
      providerRegistry.resolveUrl.mockResolvedValue(fakeDetails);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem({ providerId: 'github-pr-reviews', externalId: fakeDetails.item.externalId }));
    });

    it('creates item when user provides a valid URL', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).toHaveBeenCalledWith(
        expect.objectContaining({ title: '#42: Fix bug', notes: 'Description' }),
        expect.any(Object),
      );
      expect(providerRegistry.resolveUrl).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/42',
        expect.any(AbortSignal),
        { interactive: true },
      );
      expect(providerRegistry.registerSyntheticProviderItem).toHaveBeenCalledWith(
        'github-pr-reviews',
        expect.objectContaining({
          externalId: 'owner/repo#42',
          itemType: 'pr',
          description: 'Description',
          capabilities: expect.objectContaining({ gitWork: expect.any(Function) }),
        }),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Created'),
      );
    });

    it('seeds notes from description and falls back to an empty string', async () => {
      providerRegistry.resolveUrl.mockResolvedValueOnce({
        providerId: 'github',
        item: {
          title: '#43: Empty body',
          url: 'https://github.com/owner/repo/issues/43',
          externalId: 'owner/repo#43',
          itemType: 'issue',
        },
      });
      workGraph.createItem.mockResolvedValueOnce(createWorkItem({ providerId: 'github', externalId: 'owner/repo#43' }));
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/issues/43');

      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).toHaveBeenCalledWith(
        expect.objectContaining({ title: '#43: Empty body', notes: '' }),
        expect.any(Object),
      );
    });

    it('falls back to the entered URL when the provider item omits url', async () => {
      providerRegistry.resolveUrl.mockResolvedValueOnce({
        providerId: 'github',
        item: {
          title: '#44: Missing link',
          description: 'Body',
          externalId: 'owner/repo#44',
          itemType: 'issue',
        },
      });
      workGraph.createItem.mockResolvedValueOnce(createWorkItem({ providerId: 'github', externalId: 'owner/repo#44' }));
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/issues/44');

      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).toHaveBeenCalledWith(
        expect.objectContaining({ title: '#44: Missing link', notes: 'Body' }),
        expect.objectContaining({ url: 'https://github.com/owner/repo/issues/44' }),
      );
    });

    it('does nothing when user cancels the input box', async () => {
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);
      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(providerRegistry.resolveUrl).not.toHaveBeenCalled();
    });

    it('opens existing item instead of creating duplicate', async () => {
      const existing = createWorkItem({ id: 'existing-1', providerId: 'github-pr-reviews' });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), existing, editorPanelDependencies, undefined,
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item already exists for this source item',
      );
    });

    it('shows error when no provider recognizes the URL', async () => {
      providerRegistry.resolveUrl.mockResolvedValue(undefined);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://invalid.com/something');
      (vscode.window.showErrorMessage as Mock).mockResolvedValue(undefined);
      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: No provider recognized this URL',
        'Browse Provider Extensions',
      );
    });

    it('opens the Extensions view filtered by publisher when user clicks Browse Provider Extensions', async () => {
      providerRegistry.resolveUrl.mockResolvedValue(undefined);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://invalid.com/something');
      (vscode.window.showErrorMessage as Mock).mockResolvedValue('Browse Provider Extensions');
      await invoke('devdocket.createItemFromUrl');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.extensions.search',
        '@publisher:"devdocket"',
      );
    });

    it('silently returns when user cancels fetch (AbortError)', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      providerRegistry.resolveUrl.mockRejectedValue(abortError);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('shows provider-supplied recovery actions and invokes the selected callback', async () => {
      const run = vi.fn(async () => undefined);
      const recoverableError = makeRecoverableError({
        message: 'Recoverable error',
        actions: [{
          label: 'Reconnect',
          run,
        }],
      });
      providerRegistry.resolveUrl.mockRejectedValue(recoverableError);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      selectErrorAction('Reconnect');
      await invoke('devdocket.createItemFromUrl');

      expect(run).toHaveBeenCalledTimes(1);
      expect(providerRegistry.resolveUrl).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Recoverable error',
        expect.objectContaining({ title: 'Reconnect' }),
        expect.objectContaining({ title: 'Retry' }),
        expect.objectContaining({ title: 'Dismiss' }),
      );
    });

    it('retries after a recovery action when retryAfterAction is true', async () => {
      const authorize = vi.fn(async () => undefined);
      const recoverableError = makeRecoverableError({
        message: 'Recoverable error',
        actions: [{
          label: 'Authorize in browser',
          run: authorize,
          retryAfterAction: true,
        }],
      });
      providerRegistry.resolveUrl
        .mockRejectedValueOnce(recoverableError)
        .mockResolvedValueOnce(fakeDetails);
      (vscode.window.showInputBox as Mock).mockResolvedValueOnce('https://github.com/owner/repo/pull/42');
      selectErrorAction('Authorize in browser');
      await invoke('devdocket.createItemFromUrl');

      expect(authorize).toHaveBeenCalledTimes(1);
      expect(providerRegistry.resolveUrl).toHaveBeenCalledTimes(2);
      expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
    });

    it('omits Retry when a recoverable error is not retryable', async () => {
      const recoverableError = makeRecoverableError({
        message: 'Recoverable error',
        retryable: false,
        actions: [{
          label: 'Reconnect',
          run: vi.fn(async () => undefined),
        }],
      });
      providerRegistry.resolveUrl.mockRejectedValue(recoverableError);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      selectErrorAction('Dismiss');
      await invoke('devdocket.createItemFromUrl');

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Recoverable error',
        expect.objectContaining({ title: 'Reconnect' }),
        expect.objectContaining({ title: 'Dismiss' }),
      );
    });

    it('falls back to Retry and Dismiss when a recoverable error has no actions', async () => {
      const recoverableError = makeRecoverableError({ message: 'Recoverable error' });
      providerRegistry.resolveUrl.mockRejectedValue(recoverableError);
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      selectErrorAction('Dismiss');
      await invoke('devdocket.createItemFromUrl');

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Recoverable error',
        expect.objectContaining({ title: 'Retry' }),
        expect.objectContaining({ title: 'Dismiss' }),
      );
    });

    it('retries the command when the user selects Retry from a recoverable error notification', async () => {
      const recoverableError = makeRecoverableError({ message: 'Recoverable error' });
      providerRegistry.resolveUrl
        .mockRejectedValueOnce(recoverableError)
        .mockResolvedValueOnce(fakeDetails);
      (vscode.window.showInputBox as Mock)
        .mockResolvedValueOnce('https://github.com/owner/repo/pull/42');
      selectErrorAction('Retry');
      await invoke('devdocket.createItemFromUrl');

      expect(providerRegistry.resolveUrl).toHaveBeenCalledTimes(2);
      expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Created'),
      );
    });

    it('propagates non-abort fetch errors to wrapCommand handler', async () => {
      providerRegistry.resolveUrl.mockRejectedValue(new Error('GitHub PR owner/repo#42 not found. It may be private or deleted.'));
      (vscode.window.showInputBox as Mock).mockResolvedValue('https://github.com/owner/repo/pull/42');
      await invoke('devdocket.createItemFromUrl');

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
      );
    });
  });

  // ── simple state-transition commands ─────────────────────────────

  describe('state-transition commands', () => {
    const transitions: [string, WorkItemState][] = [
      ['devdocket.acceptToFocus', WorkItemState.InProgress],
      ['devdocket.archiveItem', WorkItemState.Archived],
      ['devdocket.completeItem', WorkItemState.Done],
      ['devdocket.pauseItem', WorkItemState.Paused],
      ['devdocket.moveToQueue', WorkItemState.New],
    ];

    for (const [cmd, expectedState] of transitions) {
      it(`${cmd} transitions to ${expectedState}`, () => {
        invoke(cmd, { id: 'wc-42' });
        expect(workGraph.transitionState).toHaveBeenCalledWith('wc-42', expectedState);
      });
    }

    it('devdocket.resumeItem calls resumeItem (delegates resume target to WorkGraph)', () => {
      invoke('devdocket.resumeItem', { id: 'wc-42' });
      expect(workGraph.resumeItem).toHaveBeenCalledWith('wc-42');
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });

    it('shows error when transitionState throws', async () => {
      workGraph.transitionState.mockRejectedValue(new Error('db crash'));
      await invoke('devdocket.archiveItem', { id: 'wc-1' });
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to archive item — db crash',
      );
    });
  });

  // ── editItem ─────────────────────────────────────────────────────

  describe('devdocket.editItem', () => {
    it('opens editor panel when item exists', () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      invoke('devdocket.editItem', { id: item.id });

      expect(workGraph.getItem).toHaveBeenCalledWith(item.id);
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(ctx, workGraph, providerRegistry, item, editorPanelDependencies, undefined);
    });

    it('passes provider label when item has providerId', () => {
      const item = createWorkItem({ providerId: 'github' });
      workGraph.getItem.mockReturnValue(item);
      labelCache.get.mockReturnValue('GitHub Issues');

      invoke('devdocket.editItem', { id: item.id });

      expect(labelCache.get).toHaveBeenCalledWith('github');
      expect(WorkItemEditorPanel.open).toHaveBeenCalledWith(ctx, workGraph, providerRegistry, item, editorPanelDependencies, 'GitHub Issues');
    });

    it('does not open editor when item is not found', () => {
      workGraph.getItem.mockReturnValue(undefined);
      invoke('devdocket.editItem', { id: 'missing' });

      expect(workGraph.getItem).toHaveBeenCalledWith('missing');
      expect(WorkItemEditorPanel.open).not.toHaveBeenCalled();
    });
  });

  // ── openInBrowser ────────────────────────────────────────────────

  describe('devdocket.openInBrowser', () => {
    it('opens workItem url when found', async () => {
      const item = createWorkItem({ url: 'https://example.com' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('devdocket.openInBrowser', { id: item.id });

      expect(vscode.env.openExternal).toHaveBeenCalled();
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://example.com/');
    });

    it('falls back to item.url when workItem has no url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('devdocket.openInBrowser', { id: 'wc-1', url: 'https://fallback.com' });

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://fallback.com/');
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('does nothing when neither source has a url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('devdocket.openInBrowser', { id: 'wc-1' });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('does nothing when item not found and tree item has no url', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('devdocket.openInBrowser', { id: 'wc-gone' });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('falls back to tree node url when workItem is not found', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('devdocket.openInBrowser', { id: 'wc-gone', url: 'https://tree-fallback.com' });

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://tree-fallback.com/');
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('shows warning and does not call openExternal for unsafe URL', async () => {
      const item = createWorkItem({ url: 'javascript:alert(1)' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('devdocket.openInBrowser', { id: item.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Cannot open non-web URL: javascript:alert(1)',
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('shows warning and does not call openExternal for data: URL', async () => {
      const item = createWorkItem({ url: 'data:text/html,<h1>hi</h1>' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('devdocket.openInBrowser', { id: item.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open non-web URL'),
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('shows warning and does not call openExternal for file: URL', async () => {
      const item = createWorkItem({ url: 'file:///etc/passwd' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('devdocket.openInBrowser', { id: item.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open non-web URL'),
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('opens url from item without id (Inbox/Sources items)', async () => {
      await invoke('devdocket.openInBrowser', { url: 'https://provider-item.com' });

      expect(workGraph.getItem).not.toHaveBeenCalled();
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://provider-item.com/');
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('rejects unsafe url-only item (Inbox/Sources)', async () => {
      await invoke('devdocket.openInBrowser', { url: 'javascript:alert(1)' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open non-web URL'),
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('shows warning when item has neither id nor url', async () => {
      await invoke('devdocket.openInBrowser', {});

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item to open in the browser.',
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
  });

  // ── copyUrl ──────────────────────────────────────────────────────

  describe('devdocket.copyUrl', () => {
    it('copies workItem url when found', async () => {
      const item = createWorkItem({ url: 'https://example.com' });
      workGraph.getItem.mockReturnValue(item);

      await invoke('devdocket.copyUrl', { id: item.id });

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('https://example.com');
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith('DevDocket: URL copied to clipboard', 3000);
    });

    it('falls back to item.url when workItem has no url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('devdocket.copyUrl', { id: 'wc-1', url: 'https://fallback.com' });

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('https://fallback.com');
    });

    it('falls back to tree node url when workItem is not found', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('devdocket.copyUrl', { id: 'wc-gone', url: 'https://tree-fallback.com' });

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('https://tree-fallback.com');
    });

    it('copies url from item without id (Inbox/Sources items)', async () => {
      await invoke('devdocket.copyUrl', { url: 'https://provider-item.com' });

      expect(workGraph.getItem).not.toHaveBeenCalled();
      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('https://provider-item.com');
    });

    it('copies non-http URLs without filtering (copy is not navigation)', async () => {
      await invoke('devdocket.copyUrl', { url: 'javascript:alert(1)' });

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('javascript:alert(1)');
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('shows warning when neither source has a url', async () => {
      workGraph.getItem.mockReturnValue(createWorkItem({ url: undefined }));

      await invoke('devdocket.copyUrl', { id: 'wc-1' });

      expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('This item has no URL to copy.');
    });

    it('shows warning when item has neither id nor url', async () => {
      await invoke('devdocket.copyUrl', {});

      expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('DevDocket: Select an item to copy its URL.');
    });
  });

  // ── runAction ────────────────────────────────────────────────────

  describe('devdocket.runAction', () => {
    it('does nothing when item is not found', async () => {
      workGraph.getItem.mockReturnValue(undefined);

      await invoke('devdocket.runAction', { id: 'missing' });

      expect(actionRegistry.getActionsFor).not.toHaveBeenCalled();
    });

    it('shows info message when no actions are available', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);
      actionRegistry.getActionsFor.mockReturnValue([]);

      await invoke('devdocket.runAction', { id: item.id });

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

      await invoke('devdocket.runAction', { id: item.id });

      expect(action.run).toHaveBeenCalledWith(item);
    });

    it('does nothing when user cancels the quick pick', async () => {
      const item = createWorkItem();
      workGraph.getItem.mockReturnValue(item);

      const action = { id: 'a', label: 'X', canRun: vi.fn(() => true), run: vi.fn() };
      actionRegistry.getActionsFor.mockReturnValue([action]);
      (vscode.window.showQuickPick as Mock).mockResolvedValue(undefined);

      await invoke('devdocket.runAction', { id: item.id });

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

      await invoke('devdocket.runAction', { id: item.id });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Action "Broken" failed — boom',
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

      await invoke('devdocket.runAction', { id: item.id });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Action "StringErr" failed — string error',
      );
    });
  });

  describe('devdocket.runActionById', () => {
    it('runs the requested action when it is still available', async () => {
      const item = createWorkItem();
      const action = { id: 'startGitWork', label: 'Start Git Work', canRun: vi.fn(() => true), run: vi.fn() };
      workGraph.getItem.mockReturnValue(item);
      actionRegistry.getAction.mockReturnValue(action);

      await invoke('devdocket.runActionById', { id: item.id, actionId: action.id });

      expect(action.run).toHaveBeenCalledWith(item);
    });

    it('shows info when the requested action is no longer available', async () => {
      const item = createWorkItem();
      const action = { id: 'startGitWork', label: 'Start Git Work', canRun: vi.fn(() => false), run: vi.fn() };
      workGraph.getItem.mockReturnValue(item);
      actionRegistry.getAction.mockReturnValue(action);

      await invoke('devdocket.runActionById', { id: item.id, actionId: action.id });

      expect(action.run).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('That action is no longer available for this item.');
    });
  });

  // ── moveUp / moveDown ────────────────────────────────────────────

  describe('devdocket.moveUp', () => {
    it('calls workGraph.moveItem with "up"', () => {
      invoke('devdocket.moveUp', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'up');
    });

    it('shows info message when item is null', () => {
      invoke('devdocket.moveUp', null);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('devdocket.moveUp', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  describe('devdocket.moveDown', () => {
    it('calls workGraph.moveItem with "down"', () => {
      invoke('devdocket.moveDown', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'down');
    });

    it('shows info message when item is undefined', () => {
      invoke('devdocket.moveDown', undefined);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item is null', () => {
      invoke('devdocket.moveDown', null);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('devdocket.moveDown', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in the Queue to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  // ── focusMoveUp / focusMoveDown ─────────────────────────────────

  describe('devdocket.focusMoveUp', () => {
    it('calls workGraph.moveItem with "up"', () => {
      invoke('devdocket.focusMoveUp', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'up');
    });

    it('shows info message when item is null', () => {
      invoke('devdocket.focusMoveUp', null);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('devdocket.focusMoveUp', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  describe('devdocket.focusMoveDown', () => {
    it('calls workGraph.moveItem with "down"', () => {
      invoke('devdocket.focusMoveDown', { id: 'wc-1' });
      expect(workGraph.moveItem).toHaveBeenCalledWith('wc-1', 'down');
    });

    it('shows info message when item is undefined', () => {
      invoke('devdocket.focusMoveDown', undefined);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });

    it('shows info message when item has no id', () => {
      invoke('devdocket.focusMoveDown', {});
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Select an item in Focus to move.',
      );
      expect(workGraph.moveItem).not.toHaveBeenCalled();
    });
  });

  // ── acceptFromInbox ──────────────────────────────────────────────

  describe('devdocket.acceptFromInbox', () => {
    it('creates a work item and sets state to accepted', async () => {
      const inboxItem = makeInboxItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('devdocket.acceptFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        { providerId: 'github', externalId: 'ext-1', url: 'https://github.com/org/repo/issues/1' },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('keeps title unprefixed and passes group when group is present', async () => {
      const inboxItem = makeInboxItem({ group: 'org/repo' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('devdocket.acceptFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        expect.objectContaining({ group: 'org/repo' }),
      );
    });

    it('does not pass group when group is empty/whitespace', async () => {
      const inboxItem = makeInboxItem({ group: '  ' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('devdocket.acceptFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        expect.any(Object),
      );
    });

    it('shows info message and sets state when item already accepted', async () => {
      const existing = createWorkItem({ title: 'Already There' });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item already accepted as "Already There"',
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('re-opens Done item back to Ready to Start when accepting resurfaced item', async () => {
      const existing = createWorkItem({ id: 'wc-done', title: 'Done Item', state: WorkItemState.Done });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-done', WorkItemState.New);
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.createItem).not.toHaveBeenCalled();
    });

    it('re-opens Archived item back to Ready to Start when accepting resurfaced item', async () => {
      const existing = createWorkItem({ id: 'wc-arch', title: 'Archived Item', state: WorkItemState.Archived });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-arch', WorkItemState.New);
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.createItem).not.toHaveBeenCalled();
    });

    it('shows error when transitionState fails for re-opening Done item', async () => {
      const existing = createWorkItem({ id: 'wc-done', title: 'Done Item', state: WorkItemState.Done });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      workGraph.transitionState.mockRejectedValue(new Error('transition error'));

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to re-open item — transition error',
      );
      expect(stateStore.setState).not.toHaveBeenCalled();
    });

    it('shows error when setState fails for existing accepted item', async () => {
      const existing = createWorkItem({ title: 'Already There' });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      stateStore.setState.mockRejectedValue(new Error('write fail'));

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item already accepted as "Already There"',
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state for existing accepted item — write fail',
      );
    });

    it('shows error when createItem fails', async () => {
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockRejectedValue(new Error('store error'));

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to accept inbox item — store error',
      );
      expect(stateStore.setState).not.toHaveBeenCalled();
    });

    it('rolls back created item when setState fails', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-1');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state after accepting item — disk full',
      );
    });

    it('logs error when rollback also fails', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-2' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));
      workGraph.deleteItem.mockRejectedValue(new Error('delete failed'));

      await invoke('devdocket.acceptFromInbox', makeInboxItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-2');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to roll back created item after setState failure',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state after accepting item — disk full',
      );
    });
  });

  // ── dismissFromInbox ─────────────────────────────────────────────

  describe('devdocket.dismissFromInbox', () => {
    it('sets state to dismissed', async () => {
      const inboxItem = makeInboxItem();
      await invoke('devdocket.dismissFromInbox', inboxItem);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
    });

    it('shows error when setState fails', async () => {
      stateStore.setState.mockRejectedValue(new Error('io error'));

      await invoke('devdocket.dismissFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to dismiss item — io error',
      );
    });

    it('shows stringified error for non-Error throw', async () => {
      stateStore.setState.mockRejectedValue('raw string');

      await invoke('devdocket.dismissFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to dismiss item — raw string',
      );
    });
  });

  // ── batch acceptFromInbox (multi-select) ──────────────────────────

  describe('devdocket.acceptFromInbox (multi-select)', () => {
    it('batch-accepts multiple items and shows summary', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to Ready to Start',
      );
    });

    it('batches canonical peer propagation for multi-select acceptance', async () => {
      const items = [
        makeInboxItem({ providerId: 'prs', externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' }),
        makeInboxItem({ providerId: 'prs', externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' }),
      ];
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(stateStore.setStates).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(1, [
        { providerId: 'prs', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'prs', externalId: 'repo#2', state: 'accepted' },
      ]);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(2, [
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'reviews', externalId: 'repo#2', state: 'accepted' },
      ]);
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

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to Ready to Start',
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

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-2');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update states after accepting items — disk full',
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

      await invoke('devdocket.acceptFromInbox', items[0], items);

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
        'DevDocket: Failed to accept 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 of 3 items to Ready to Start',
      );
    });

    it('propagates canonical peers only for items accepted successfully', async () => {
      const items = [
        makeInboxItem({ providerId: 'prs', externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' }),
        makeInboxItem({ providerId: 'prs', externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' }),
      ];
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockRejectedValueOnce(new Error('create failed'));

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(stateStore.setStates).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(1, [
        { providerId: 'prs', externalId: 'repo#1', state: 'accepted' },
      ]);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(2, [
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
      ]);
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeInboxItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem());

      await invoke('devdocket.acceptFromInbox', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo', unseenCount: 3 };
      const inboxItem = makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem({ id: 'wc-1' }));

      await invoke('devdocket.acceptFromInbox', providerNode, [providerNode, groupNode, inboxItem]);

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

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Issue 1' },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-1', group: 'octocat/repo' }),
      );
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Issue 2' },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-2', group: 'octocat/other' }),
      );
    });

    it('normalizes whitespace-only group to undefined in batch accept', async () => {
      const items = [makeInboxItem({ externalId: 'ext-ws', title: 'Whitespace', group: '  ' })];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValueOnce(createWorkItem({ id: 'wc-ws' }));

      await invoke('devdocket.acceptFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
      const provenance = workGraph.createItem.mock.calls[0][1];
      expect(provenance).not.toHaveProperty('group');
    });
  });

  // ── batch dismissFromInbox (multi-select) ─────────────────────────

  describe('devdocket.dismissFromInbox (multi-select)', () => {
    it('batch-dismisses multiple items and shows summary', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1' }),
        makeInboxItem({ externalId: 'ext-2' }),
      ];

      await invoke('devdocket.dismissFromInbox', items[0], items);

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

      await invoke('devdocket.dismissFromInbox', items[0], items);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to dismiss items — io error',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeInboxItem();

      await invoke('devdocket.dismissFromInbox', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo', unseenCount: 3 };
      const inboxItem = makeInboxItem({ externalId: 'ext-1' });

      await invoke('devdocket.dismissFromInbox', providerNode, [providerNode, groupNode, inboxItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does nothing when selectedItems contains only non-item nodes', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo', unseenCount: 3 };

      await invoke('devdocket.dismissFromInbox', providerNode, [providerNode, groupNode]);

      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('falls back to context item when it is not in the selection', async () => {
      const contextItem = makeInboxItem({ externalId: 'ext-ctx' });
      const selectedItem = makeInboxItem({ externalId: 'ext-other' });

      await invoke('devdocket.dismissFromInbox', contextItem, [selectedItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-ctx', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });
  });

  function mockDiscoveredInboxItems(entries: Array<[string, any[]]>) {
    const discovered = new Map(entries);
    providerRegistry.getAllProviderItems.mockReturnValue(discovered);
    providerRegistry.getProviderItems.mockImplementation((providerId: string) => discovered.get(providerId) ?? []);
  }

  describe('bulk inbox node commands', () => {
    it('dismisses all unseen provider items after confirmation', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1' },
        { externalId: 'ext-2', title: 'Issue 2' },
        { externalId: 'ext-3', title: 'Done already' },
      ]]]);
      stateStore.getState.mockImplementation((_providerId: string, externalId: string) => externalId === 'ext-3' ? 'accepted' : undefined);
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce('Dismiss All');

      await invoke('devdocket.dismissAllFromInbox', providerNode);

      expect(vscode.window.showWarningMessage).toHaveBeenNthCalledWith(
        1,
        'Dismiss 2 items from "GitHub"?',
        { modal: true },
        'Dismiss All',
      );
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'dismissed' },
        { providerId: 'github', externalId: 'ext-2', state: 'dismissed' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Dismissed 2 items');
    });

    it('shows the expanded canonical peer count in bulk dismiss confirmation', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'prs', label: 'GitHub' };
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce('Dismiss All');

      await invoke('devdocket.dismissAllFromInbox', providerNode);

      expect(vscode.window.showWarningMessage).toHaveBeenNthCalledWith(
        1,
        'Dismiss 4 items from "GitHub"?',
        { modal: true },
        'Dismiss All',
      );
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'prs', externalId: 'repo#1', state: 'dismissed' },
        { providerId: 'prs', externalId: 'repo#2', state: 'dismissed' },
        { providerId: 'reviews', externalId: 'repo#1', state: 'dismissed' },
        { providerId: 'reviews', externalId: 'repo#2', state: 'dismissed' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Dismissed 4 items');
    });

    it('dismisses all unseen group items after confirmation', async () => {
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'My Mentions', unseenCount: 2 };
      providerRegistry.getProviderLabel.mockReturnValue('GitHub');
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1', group: 'My Mentions' },
        { externalId: 'ext-2', title: 'Issue 2', group: 'My Mentions' },
        { externalId: 'ext-3', title: 'Issue 3', group: 'Other' },
      ]]]);
      stateStore.getState.mockReturnValue(undefined);
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce('Dismiss All');

      await invoke('devdocket.dismissAllFromInbox', groupNode);

      expect(vscode.window.showWarningMessage).toHaveBeenNthCalledWith(
        1,
        'Dismiss 2 items from "GitHub > My Mentions"?',
        { modal: true },
        'Dismiss All',
      );
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'dismissed' },
        { providerId: 'github', externalId: 'ext-2', state: 'dismissed' },
      ]);
    });

    it('accepts all provider items to Ready to Start after confirmation', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1' },
        { externalId: 'ext-2', title: 'Issue 2' },
      ]]]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Accept All to Ready to Start');

      await invoke('devdocket.acceptAllFromInbox', providerNode);

      expect(vscode.window.showInformationMessage).toHaveBeenNthCalledWith(
        1,
        'Accept 2 items from "GitHub" to Ready to Start?',
        { modal: true },
        'Accept All to Ready to Start',
      );
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
    });

    it('accepts an explicit item array without a second confirmation and returns successes', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      const result = await invoke('devdocket.acceptAllFromInbox', items);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('Accept 2 items'),
        { modal: true },
        'Accept All to Ready to Start',
      );
      expect(result).toEqual(items);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
    });

    it('accepts all group items to Ready to Start after confirmation', async () => {
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'My Mentions', unseenCount: 2 };
      providerRegistry.getProviderLabel.mockReturnValue('GitHub');
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1', group: 'My Mentions' },
        { externalId: 'ext-2', title: 'Issue 2', group: 'My Mentions' },
        { externalId: 'ext-3', title: 'Issue 3', group: 'Other' },
      ]]]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Accept All to Ready to Start');

      await invoke('devdocket.acceptAllFromInbox', groupNode);

      expect(vscode.window.showInformationMessage).toHaveBeenNthCalledWith(
        1,
        'Accept 2 items from "GitHub > My Mentions" to Ready to Start?',
        { modal: true },
        'Accept All to Ready to Start',
      );
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Issue 1', description: undefined },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-1', group: 'My Mentions' }),
      );
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Issue 2', description: undefined },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-2', group: 'My Mentions' }),
      );
    });

    it('accepts all provider items to In Progress after confirmation', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1' },
        { externalId: 'ext-2', title: 'Issue 2' },
      ]]]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Accept All to In Progress');

      await invoke('devdocket.acceptAllToFocusFromInbox', providerNode);

      expect(vscode.window.showInformationMessage).toHaveBeenNthCalledWith(
        1,
        'Accept 2 items from "GitHub" to In Progress?',
        { modal: true },
        'Accept All to In Progress',
      );
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
    });

    it('accepts all group items to In Progress after confirmation', async () => {
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'github', groupName: 'My Mentions', unseenCount: 2 };
      providerRegistry.getProviderLabel.mockReturnValue('GitHub');
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1', group: 'My Mentions' },
        { externalId: 'ext-2', title: 'Issue 2', group: 'My Mentions' },
        { externalId: 'ext-3', title: 'Issue 3', group: 'Other' },
      ]]]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Accept All to In Progress');

      await invoke('devdocket.acceptAllToFocusFromInbox', groupNode);

      expect(vscode.window.showInformationMessage).toHaveBeenNthCalledWith(
        1,
        'Accept 2 items from "GitHub > My Mentions" to In Progress?',
        { modal: true },
        'Accept All to In Progress',
      );
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Issue 1', description: undefined },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-1', group: 'My Mentions' }),
      );
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Issue 2', description: undefined },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-2', group: 'My Mentions' }),
      );
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
    });

    it('does nothing for empty nodes without confirming', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      mockDiscoveredInboxItems([['github', []]]);

      await invoke('devdocket.acceptAllFromInbox', providerNode);
      await invoke('devdocket.acceptAllToFocusFromInbox', providerNode);
      await invoke('devdocket.dismissAllFromInbox', providerNode);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does nothing when the user cancels bulk confirmation', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      mockDiscoveredInboxItems([['github', [
        { externalId: 'ext-1', title: 'Issue 1' },
      ]]]);
      stateStore.getState.mockReturnValue(undefined);
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce(undefined);
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce(undefined);

      await invoke('devdocket.acceptAllFromInbox', providerNode);
      await invoke('devdocket.dismissAllFromInbox', providerNode);

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(workGraph.transitionState).not.toHaveBeenCalled();
      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('keeps canonical-hidden peers out of provider resolution while propagating acceptance', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'prs', label: 'GitHub' };
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Accept All to Ready to Start');

      await invoke('devdocket.acceptAllFromInbox', providerNode);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(1, [
        { providerId: 'prs', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'prs', externalId: 'repo#2', state: 'accepted' },
      ]);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(2, [
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'reviews', externalId: 'repo#2', state: 'accepted' },
      ]);
    });

    it('accepts canonical-hidden peers to In Progress with a single propagation batch', async () => {
      const providerNode: InboxProviderNode = { kind: 'provider', providerId: 'prs', label: 'GitHub' };
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Accept All to In Progress');

      await invoke('devdocket.acceptAllToFocusFromInbox', providerNode);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(1, [
        { providerId: 'prs', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'prs', externalId: 'repo#2', state: 'accepted' },
      ]);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(2, [
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'reviews', externalId: 'repo#2', state: 'accepted' },
      ]);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
    });
  });

  // ── batch state-transition commands (multi-select) ──────────────────

  describe('batch acceptToFocus (multi-select)', () => {
    it('transitions multiple items to InProgress', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];
      await invoke('devdocket.acceptToFocus', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-3', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 3 items to In Progress');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('devdocket.acceptToFocus', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('continues after partial failure', async () => {
      workGraph.transitionState
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('bad state'))
        .mockResolvedValueOnce(undefined);
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];

      await invoke('devdocket.acceptToFocus', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to transition item wc-2',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to transition 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 2 items to In Progress');
    });

    it('does nothing when no items have ids', async () => {
      await invoke('devdocket.acceptToFocus', {}, [{}]);
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });

    it('falls back to context item when it is not in selection', async () => {
      await invoke('devdocket.acceptToFocus', { id: 'wc-ctx' }, [{ id: 'wc-other' }]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-ctx', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledTimes(1);
    });
  });

  // ── acceptToFocusFromInbox (single item) ───────────────────────────

  describe('devdocket.acceptToFocusFromInbox', () => {
    it('creates WorkItem, sets state to accepted, and transitions to InProgress for a new item', async () => {
      const inboxItem = makeInboxItem();
      const created = createWorkItem({ id: 'wc-new-1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(created);

      await invoke('devdocket.acceptToFocusFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        { providerId: 'github', externalId: 'ext-1', url: 'https://github.com/org/repo/issues/1' },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-new-1', WorkItemState.InProgress);
    });

    it('keeps title unprefixed and passes group when accepting a new item to InProgress', async () => {
      const inboxItem = makeInboxItem({ group: 'org/repo' });
      const created = createWorkItem({ id: 'wc-new-group' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(created);

      await invoke('devdocket.acceptToFocusFromInbox', inboxItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Inbox Issue' },
        expect.objectContaining({ providerId: 'github', externalId: 'ext-1', group: 'org/repo' }),
      );
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-new-group', WorkItemState.InProgress);
    });

    it('sets state to accepted and transitions existing New item to InProgress', async () => {
      const existing = createWorkItem({ id: 'wc-exist', state: WorkItemState.New });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-exist', WorkItemState.InProgress);
    });

    it('shows info message and does not transition when item is already InProgress', async () => {
      const existing = createWorkItem({ id: 'wc-focus', state: WorkItemState.InProgress });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item is already In Progress',
      );
      expect(workGraph.transitionState).not.toHaveBeenCalled();
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('shows info message and does not transition when item is Paused', async () => {
      const existing = createWorkItem({ id: 'wc-paused', state: WorkItemState.Paused });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item is already In Progress',
      );
      expect(workGraph.transitionState).not.toHaveBeenCalled();
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('re-opens Done item and transitions to In Progress', async () => {
      const existing = createWorkItem({ id: 'wc-done', state: WorkItemState.Done });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-done', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-done', WorkItemState.InProgress);
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('re-opens Archived item and transitions to In Progress', async () => {
      const existing = createWorkItem({ id: 'wc-arch', state: WorkItemState.Archived });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-arch', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-arch', WorkItemState.InProgress);
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
    });

    it('returns early with no errors for empty selection', async () => {
      await invoke('devdocket.acceptToFocusFromInbox', undefined);

      expect(workGraph.findItemByProvenance).not.toHaveBeenCalled();
      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });

    // ── failure / rollback paths ──────────────────────────────────────

    it('surfaces error and makes no state changes when createItem throws', async () => {
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockRejectedValue(new Error('disk full'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(workGraph.transitionState).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to accept inbox item to In Progress — disk full',
      );
    });

    it('rolls back created item via deleteItem when setState fails after createItem', async () => {
      const created = createWorkItem({ id: 'wc-rollback' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(created);
      stateStore.setState.mockRejectedValue(new Error('state write failed'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-rollback');
      expect(workGraph.transitionState).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state after accepting item — state write failed',
      );
    });

    it('logs rollback failure but still surfaces original setState error', async () => {
      const created = createWorkItem({ id: 'wc-rollback-fail' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(created);
      stateStore.setState.mockRejectedValue(new Error('state write failed'));
      workGraph.deleteItem.mockRejectedValue(new Error('delete also failed'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-rollback-fail');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to roll back created item after setState failure',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state after accepting item — state write failed',
      );
    });

    it('surfaces error when transitionState fails for a new item', async () => {
      const created = createWorkItem({ id: 'wc-trans-fail' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(created);
      workGraph.transitionState.mockRejectedValue(new Error('bad transition'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to move item to In Progress — bad transition',
      );
    });

    it('surfaces error when transitionState fails for an existing New item', async () => {
      const existing = createWorkItem({ id: 'wc-exist-trans', state: WorkItemState.New });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      workGraph.transitionState.mockRejectedValue(new Error('transition error'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to move item to In Progress — transition error',
      );
    });

    it('returns early with error when setState fails for InProgress item', async () => {
      const existing = createWorkItem({ id: 'wc-ip', state: WorkItemState.InProgress });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      stateStore.setState.mockRejectedValue(new Error('state error'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state for existing focus item — state error',
      );
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });

    it('returns early with error when transitionState fails for Done item', async () => {
      const existing = createWorkItem({ id: 'wc-done-err', state: WorkItemState.Done });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      workGraph.transitionState.mockRejectedValue(new Error('transition error'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to re-open item — transition error',
      );
      expect(stateStore.setState).not.toHaveBeenCalled();
    });

    it('returns early with error when transitionState fails for Archived item', async () => {
      const existing = createWorkItem({ id: 'wc-arch-err', state: WorkItemState.Archived });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      workGraph.transitionState.mockRejectedValue(new Error('transition error'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to re-open item — transition error',
      );
      expect(stateStore.setState).not.toHaveBeenCalled();
    });

    it('returns early with error when setState fails for existing New item', async () => {
      const existing = createWorkItem({ id: 'wc-new-err', state: WorkItemState.New });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      stateStore.setState.mockRejectedValue(new Error('state error'));

      await invoke('devdocket.acceptToFocusFromInbox', makeInboxItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state for existing accepted item — state error',
      );
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });
  });

  // ── batch acceptToFocusFromInbox (multi-select) ───────────────────

  describe('devdocket.acceptToFocusFromInbox (multi-select)', () => {
    it('batch-accepts items: creates, sets states, and transitions all to InProgress', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to In Progress',
      );
    });

    it('batches canonical peer propagation for multi-select accept-to-focus', async () => {
      const items = [
        makeInboxItem({ providerId: 'prs', externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' }),
        makeInboxItem({ providerId: 'prs', externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' }),
      ];
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(stateStore.setStates).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(1, [
        { providerId: 'prs', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'prs', externalId: 'repo#2', state: 'accepted' },
      ]);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(2, [
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
        { providerId: 'reviews', externalId: 'repo#2', state: 'accepted' },
      ]);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
    });

    it('continues processing when some createItem calls fail', async () => {
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

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(3);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-3', state: 'accepted' },
      ]);
      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to accept inbox item to In Progress "Issue 2"',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to process 1 item(s); see Output for details',
      );
    });

    it('propagates canonical peers only for items accepted to In Progress successfully', async () => {
      const items = [
        makeInboxItem({ providerId: 'prs', externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' }),
        makeInboxItem({ providerId: 'prs', externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' }),
      ];
      mockDiscoveredInboxItems([
        ['prs', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
        ['reviews', [
          { externalId: 'repo#1', title: 'Issue 1', canonicalId: 'github:pull:repo#1' },
          { externalId: 'repo#2', title: 'Issue 2', canonicalId: 'github:pull:repo#2' },
        ]],
      ]);
      stateStore.getState.mockReturnValue(undefined);
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockRejectedValueOnce(new Error('create failed'));

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(stateStore.setStates).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(1, [
        { providerId: 'prs', externalId: 'repo#1', state: 'accepted' },
      ]);
      expect(stateStore.setStates).toHaveBeenNthCalledWith(2, [
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
      ]);
    });

    it('rolls back createdIds when batch setStates fails', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));
      stateStore.setStates.mockRejectedValue(new Error('disk full'));

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-2');
      expect(workGraph.transitionState).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update states after accepting items — disk full',
      );
    });

    it('shows correct counts when some transitions fail', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
        makeInboxItem({ externalId: 'ext-3', title: 'Issue 3' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-3' }));
      workGraph.transitionState
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('bad state'))
        .mockResolvedValueOnce(undefined);

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to In Progress (1 failed)',
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to process 1 item(s); see Output for details',
      );
    });

    it('re-opens Done/Archived items and skips InProgress items', async () => {
      const items = [
        makeInboxItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeInboxItem({ externalId: 'ext-2', title: 'Issue 2' }),
        makeInboxItem({ externalId: 'ext-3', title: 'Issue 3' }),
      ];
      workGraph.findItemByProvenance
        .mockReturnValueOnce(createWorkItem({ id: 'wc-1', state: WorkItemState.InProgress }))
        .mockReturnValueOnce(createWorkItem({ id: 'wc-2', state: WorkItemState.Done }))
        .mockReturnValueOnce(undefined);
      workGraph.createItem.mockResolvedValueOnce(createWorkItem({ id: 'wc-3' }));

      await invoke('devdocket.acceptToFocusFromInbox', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
      // wc-2 re-opened (Done→New), then both wc-2 and wc-3 transitioned to InProgress
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.InProgress);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-3', WorkItemState.InProgress);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 items to In Progress; 1 item already In Progress or cannot be moved',
      );
    });
  });

  describe('batch archiveItem (multi-select)', () => {
    it('archives multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('devdocket.archiveItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Archived);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.Archived);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Archived 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('devdocket.archiveItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Archived);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch completeItem (multi-select)', () => {
    it('completes multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('devdocket.completeItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Done);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.Done);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Completed 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('devdocket.completeItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Done);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch pauseItem (multi-select)', () => {
    it('pauses multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('devdocket.pauseItem', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(2);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Paused);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.Paused);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Paused 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('devdocket.pauseItem', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.Paused);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch resumeItem (multi-select)', () => {
    it('resumes multiple items', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }];
      await invoke('devdocket.resumeItem', items[0], items);

      expect(workGraph.resumeItem).toHaveBeenCalledTimes(2);
      expect(workGraph.resumeItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.resumeItem).toHaveBeenCalledWith('wc-2');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Resumed 2 items');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('devdocket.resumeItem', item, [item]);

      expect(workGraph.resumeItem).toHaveBeenCalledWith('wc-1');
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('batch moveToQueue (multi-select)', () => {
    it('moves multiple items to Ready to Start', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];
      await invoke('devdocket.moveToQueue', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-2', WorkItemState.New);
      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-3', WorkItemState.New);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 3 items to Ready to Start');
    });

    it('uses single-item path when one item selected', async () => {
      const item = { id: 'wc-1' };
      await invoke('devdocket.moveToQueue', item, [item]);

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-1', WorkItemState.New);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('continues after partial failure', async () => {
      workGraph.transitionState
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('bad state'))
        .mockResolvedValueOnce(undefined);
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];

      await invoke('devdocket.moveToQueue', items[0], items);

      expect(workGraph.transitionState).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to transition item wc-2',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to transition 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Moved 2 items to Ready to Start');
    });

    it('does nothing when no items have ids', async () => {
      await invoke('devdocket.moveToQueue', {}, [{}]);
      expect(workGraph.transitionState).not.toHaveBeenCalled();
    });
  });

  // ── deleteItem ──────────────────────────────────────────────────────

  describe('devdocket.deleteItem', () => {
    beforeEach(() => {
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');
    });

    it('deletes a single item after confirmation', async () => {
      await invoke('devdocket.deleteItem', { id: 'wc-1' });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete item? This cannot be undone.',
        { modal: true },
        'Delete',
      );
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
    });

    it('does nothing when user cancels confirmation', async () => {
      (vscode.window.showWarningMessage as Mock).mockResolvedValue(undefined);
      await invoke('devdocket.deleteItem', { id: 'wc-1' });
      expect(workGraph.deleteItem).not.toHaveBeenCalled();
    });

    it('does nothing when item has no id', async () => {
      await invoke('devdocket.deleteItem', {});
      expect(workGraph.deleteItem).not.toHaveBeenCalled();
    });

    it('batch deletes multiple items after confirmation', async () => {
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];
      await invoke('devdocket.deleteItem', items[0], items);

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
      await invoke('devdocket.deleteItem', item, [item]);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('continues after partial failure in batch', async () => {
      workGraph.deleteItem
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce(undefined);
      const items = [{ id: 'wc-1' }, { id: 'wc-2' }, { id: 'wc-3' }];

      await invoke('devdocket.deleteItem', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to delete item wc-2',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to delete 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Deleted 2 items');
    });

    it('shows error when single delete fails', async () => {
      workGraph.deleteItem.mockRejectedValue(new Error('db error'));
      await invoke('devdocket.deleteItem', { id: 'wc-1' });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to delete item — db error',
      );
    });
  });

  // ── batch acceptFromSources (multi-select) ──────────────────────────

  describe('devdocket.acceptFromSources (multi-select)', () => {
    it('batch-accepts multiple source items', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' }),
        makeSourceItem({ externalId: 'ext-2', title: 'Issue 2' }),
      ];
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-1' }))
        .mockResolvedValueOnce(createWorkItem({ id: 'wc-2' }));

      await invoke('devdocket.acceptFromSources', items[0], items);

      expect(workGraph.createItem).toHaveBeenCalledTimes(2);
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'github', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'github', externalId: 'ext-2', state: 'accepted' },
      ]);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Accepted 2 items to Ready to Start');
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

      await invoke('devdocket.acceptFromSources', items[0], items);

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

      await invoke('devdocket.acceptFromSources', items[0], items);

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-1');
      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-2');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update states after accepting items — disk full',
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

      await invoke('devdocket.acceptFromSources', items[0], items);

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
        'DevDocket: Failed to accept 1 item(s); see Output for details',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Accepted 2 of 3 items to Ready to Start',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeSourceItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem());

      await invoke('devdocket.acceptFromSources', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo' };
      const sourceItem = makeSourceItem({ externalId: 'ext-1', title: 'Issue 1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem({ id: 'wc-1' }));

      await invoke('devdocket.acceptFromSources', providerNode, [providerNode, groupNode, sourceItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'accepted');
      expect(workGraph.createItem).toHaveBeenCalledTimes(1);
    });
  });

  // ── dismissFromSources ──────────────────────────────────────────────

  describe('devdocket.dismissFromSources', () => {
    it('dismisses a single source item', async () => {
      await invoke('devdocket.dismissFromSources', makeSourceItem());

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'dismissed');
    });

    it('shows error when single dismiss fails', async () => {
      stateStore.setState.mockRejectedValue(new Error('io error'));

      await invoke('devdocket.dismissFromSources', makeSourceItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to dismiss item — io error',
      );
    });

    it('batch-dismisses multiple source items', async () => {
      const items = [
        makeSourceItem({ externalId: 'ext-1' }),
        makeSourceItem({ externalId: 'ext-2' }),
      ];

      await invoke('devdocket.dismissFromSources', items[0], items);

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

      await invoke('devdocket.dismissFromSources', items[0], items);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to dismiss items — io error',
      );
    });

    it('uses single-item path when selectedItems has one item', async () => {
      const item = makeSourceItem();

      await invoke('devdocket.dismissFromSources', item, [item]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('filters out non-item nodes from selectedItems', async () => {
      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo' };
      const sourceItem = makeSourceItem({ externalId: 'ext-1' });

      await invoke('devdocket.dismissFromSources', providerNode, [providerNode, groupNode, sourceItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-1', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does nothing when selectedItems contains only non-item nodes', async () => {
      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github', label: 'GitHub' };
      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'github', groupName: 'org/repo' };

      await invoke('devdocket.dismissFromSources', providerNode, [providerNode, groupNode]);

      expect(stateStore.setState).not.toHaveBeenCalled();
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('falls back to context item when it is not in the selection', async () => {
      const contextItem = makeSourceItem({ externalId: 'ext-ctx' });
      const selectedItem = makeSourceItem({ externalId: 'ext-other' });

      await invoke('devdocket.dismissFromSources', contextItem, [selectedItem]);

      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-ctx', 'dismissed');
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });
  });

  // ── acceptFromSources────────────────────────────────────────────

  describe('devdocket.acceptFromSources', () => {
    it('creates a work item and sets state to accepted for new item', async () => {
      const sourceItem = makeSourceItem();
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('devdocket.acceptFromSources', sourceItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Source Issue' },
        { providerId: 'github', externalId: 'ext-2', url: 'https://github.com/org/repo/issues/2' },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
    });

    it('sets state to accepted without creating when item already exists', async () => {
      const existing = createWorkItem({ title: 'Existing' });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(workGraph.createItem).not.toHaveBeenCalled();
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item already accepted as "Existing"',
      );
    });

    it('re-opens Done item back to Ready to Start when accepting from sources', async () => {
      const existing = createWorkItem({ id: 'wc-done', title: 'Done Item', state: WorkItemState.Done });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-done', WorkItemState.New);
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
      expect(workGraph.createItem).not.toHaveBeenCalled();
    });

    it('re-opens Archived item back to Ready to Start when accepting from sources', async () => {
      const existing = createWorkItem({ id: 'wc-arch', title: 'Archived Item', state: WorkItemState.Archived });
      workGraph.findItemByProvenance.mockReturnValue(existing);

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(workGraph.transitionState).toHaveBeenCalledWith('wc-arch', WorkItemState.New);
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'ext-2', 'accepted');
      expect(workGraph.createItem).not.toHaveBeenCalled();
    });

    it('shows error when setState fails for existing item', async () => {
      const existing = createWorkItem({ title: 'Existing' });
      workGraph.findItemByProvenance.mockReturnValue(existing);
      stateStore.setState.mockRejectedValue(new Error('write fail'));

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Item already accepted as "Existing"',
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state for existing item — write fail',
      );
    });

    it('shows error when createItem fails for new item', async () => {
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockRejectedValue(new Error('store error'));

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to accept sources item — store error',
      );
    });

    it('keeps title unprefixed and passes group for source items with group', async () => {
      const sourceItem = makeSourceItem({ group: 'myorg/myrepo' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);

      await invoke('devdocket.acceptFromSources', sourceItem);

      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Source Issue' },
        expect.objectContaining({ group: 'myorg/myrepo' }),
      );
    });

    it('rolls back created item when setState fails for new item', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-3' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-3');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state after accepting item — disk full',
      );
    });

    it('logs error when rollback also fails for new item', async () => {
      const createdItem = createWorkItem({ id: 'wc-new-4' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createdItem);
      stateStore.setState.mockRejectedValue(new Error('disk full'));
      workGraph.deleteItem.mockRejectedValue(new Error('delete failed'));

      await invoke('devdocket.acceptFromSources', makeSourceItem());

      expect(workGraph.deleteItem).toHaveBeenCalledWith('wc-new-4');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to roll back created item after setState failure',
        expect.any(Error),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Failed to update state after accepting item — disk full',
      );
    });
  });

  // ── Sources canonical peer propagation ────────────────────────────

  describe('Sources canonical peer propagation', () => {
    function setupCanonicalPeers() {
      const items = new Map<string, any[]>();
      items.set('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      items.set('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      providerRegistry.getAllProviderItems.mockReturnValue(items);
      // stateStore.getState returns undefined (unseen) for peers
      stateStore.getState.mockReturnValue(undefined);
    }

    it('acceptFromSources propagates accepted state to canonical peers', async () => {
      setupCanonicalPeers();
      const sourceItem = makeSourceItem({
        providerId: 'prs',
        externalId: 'repo#1',
        canonicalId: 'github:pull:repo#1',
      });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem());

      await invoke('devdocket.acceptFromSources', sourceItem);

      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'reviews', externalId: 'repo#1', state: 'accepted' },
      ]);
    });

    it('dismissFromSources propagates dismissed state to canonical peers', async () => {
      setupCanonicalPeers();
      const sourceItem = makeSourceItem({
        providerId: 'prs',
        externalId: 'repo#1',
        canonicalId: 'github:pull:repo#1',
      });

      await invoke('devdocket.dismissFromSources', sourceItem);

      expect(stateStore.setState).toHaveBeenCalledWith('prs', 'repo#1', 'dismissed');
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'reviews', externalId: 'repo#1', state: 'dismissed' },
      ]);
    });

    it('does not propagate when item has no canonicalId', async () => {
      providerRegistry.getAllProviderItems.mockReturnValue(new Map());
      const sourceItem = makeSourceItem({ providerId: 'prs', externalId: 'repo#1' });
      workGraph.findItemByProvenance.mockReturnValue(undefined);
      workGraph.createItem.mockResolvedValue(createWorkItem());

      await invoke('devdocket.acceptFromSources', sourceItem);

      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does not propagate to already-accepted peers', async () => {
      const items = new Map<string, any[]>();
      items.set('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      items.set('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      providerRegistry.getAllProviderItems.mockReturnValue(items);
      stateStore.getState.mockReturnValue('accepted');

      const sourceItem = makeSourceItem({
        providerId: 'prs',
        externalId: 'repo#1',
        canonicalId: 'github:pull:repo#1',
      });

      await invoke('devdocket.dismissFromSources', sourceItem);

      // Peer is already accepted, so setStates should not be called for propagation
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });
  });

  describe('devdocket.clearHistory', () => {
    function mockConfig(value: any = 30) {
      (vscode.workspace.getConfiguration as Mock).mockReturnValue({
        get: vi.fn((_key: string, _def?: any) => value),
        update: vi.fn(),
        inspect: vi.fn(),
      });
    }

    it('shows confirmation dialog and clears old history', async () => {
      mockConfig(30);
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');
      workGraph.clearOldHistory.mockResolvedValue({ deleted: 5, failed: 0 });

      await invoke('devdocket.clearHistory');

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('older than 30 day'),
        { modal: true },
        'Delete',
      );
      expect(workGraph.clearOldHistory).toHaveBeenCalledWith(30);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('5 old history items'),
      );
    });

    it('does nothing when user cancels confirmation', async () => {
      mockConfig(30);
      (vscode.window.showWarningMessage as Mock).mockResolvedValue(undefined);

      await invoke('devdocket.clearHistory');

      expect(workGraph.clearOldHistory).not.toHaveBeenCalled();
    });

    it('shows no-items message when nothing to clear', async () => {
      mockConfig(30);
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');
      workGraph.clearOldHistory.mockResolvedValue({ deleted: 0, failed: 0 });

      await invoke('devdocket.clearHistory');

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('No history items older'),
      );
    });

    it('uses singular form for 1 day threshold', async () => {
      mockConfig(1);
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');
      workGraph.clearOldHistory.mockResolvedValue({ deleted: 1, failed: 0 });

      await invoke('devdocket.clearHistory');

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('older than 1 day'),
        { modal: true },
        'Delete',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 old history item'),
      );
    });

    it('falls back to default 30 for invalid config values', async () => {
      mockConfig(NaN);
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');
      workGraph.clearOldHistory.mockResolvedValue({ deleted: 0, failed: 0 });

      await invoke('devdocket.clearHistory');

      expect(workGraph.clearOldHistory).toHaveBeenCalledWith(30);
    });
  });

  describe('devdocket.dismissWatch', () => {
    it('shows info message when no argument provided', async () => {
      await invoke('devdocket.dismissWatch');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Select a watch from the Watches view to dismiss.',
      );
    });
  });

  describe('devdocket.openWatchUrl', () => {
    it('shows info message when no argument provided', async () => {
      await invoke('devdocket.openWatchUrl');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Select a watch from the Watches view to open.',
      );
    });
  });

  // ── addActivity ────────────────────────────────────────────────

  describe('devdocket.addActivity', () => {
    it('calls workGraph.addActivity with the provided args', async () => {
      await invoke('devdocket.addActivity', 'wc-1', 'work-started', '{"branchName":"feat"}');

      expect(workGraph.addActivity).toHaveBeenCalledWith('wc-1', 'work-started', '{"branchName":"feat"}');
    });

    it('works without optional detail parameter', async () => {
      await invoke('devdocket.addActivity', 'wc-1', 'cleanup-dismissed');

      expect(workGraph.addActivity).toHaveBeenCalledWith('wc-1', 'cleanup-dismissed', undefined);
    });
  });
});

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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ViewColumn, window } from 'vscode';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { WorkGraph } from '../services/workGraph';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';

type MessageHandler = (msg: any) => void | Promise<void>;
type DisposeHandler = () => void;

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    title: 'Test item',
    state: WorkItemState.InProgress,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// --- Unit-test helpers (mock WorkGraph) ---

function createMockWebviewPanel() {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: DisposeHandler | undefined;
  const panel = {
    title: '',
    webview: {
      html: '',
      cspSource: 'https://test.csp',
      onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
        return { dispose: vi.fn(() => { messageHandler = undefined; }) };
      }),
      postMessage: vi.fn(async () => true),
    },
    onDidDispose: vi.fn((handler: DisposeHandler) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
    reveal: vi.fn(),
  };
  return {
    panel,
    simulateMessage: (msg: any) => messageHandler?.(msg) ?? Promise.resolve(),
    simulateDispose: () => disposeHandler?.(),
  };
}

function createMockWorkGraph(item?: WorkItem) {
  return {
    getItem: vi.fn((id: string) => (item && item.id === id ? item : undefined)),
    updateItem: vi.fn(async () => {}),
  };
}

function createMockContext() {
  const subscriptions: { dispose: () => void }[] = [];
  return {
    subscriptions,
    extensionUri: { toString: () => 'file:///ext' },
  } as any;
}

function createMockProviderRegistry() {
  const discoveredEmitter = new EventEmitter<void>();
  return {
    getDiscoveredItems: vi.fn(() => []),
    getProvider: vi.fn((id: string) => id ? { id } : undefined),
    onDidChangeDiscoveredItems: discoveredEmitter.event,
    _fireDiscoveredItemsChange: () => discoveredEmitter.fire(),
  };
}

function openPanel(
  item: WorkItem,
  workGraph: ReturnType<typeof createMockWorkGraph>,
  mock: ReturnType<typeof createMockWebviewPanel>,
  context = createMockContext(),
  providerRegistry = createMockProviderRegistry(),
) {
  vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);
  WorkItemEditorPanel.open(context, workGraph as any, providerRegistry as any, item);
  return context;
}

// --- Integration-test helpers (real WorkGraph) ---

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createIntegrationWebviewPanel() {
  const messageListeners: Function[] = [];
  const disposeListeners: Function[] = [];
  return {
    webview: {
      html: '',
      cspSource: 'mock-csp-source',
      onDidReceiveMessage: vi.fn((listener: Function) => {
        messageListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn(async () => true),
      _fireMessage: (msg: any) => { messageListeners.forEach(l => l(msg)); },
    },
    onDidDispose: vi.fn((listener: Function) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    _fireDispose: () => { disposeListeners.forEach(l => l()); },
    dispose: vi.fn(),
    title: '',
    reveal: vi.fn(),
  };
}

function createIntegrationContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe('WorkItemEditorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WorkItemEditorPanel.clearPanelCache();
  });

  describe('open (panel creation)', () => {
    it('should create a webview panel with correct title', () => {
      const item = makeItem({ title: 'My Task' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(window.createWebviewPanel).toHaveBeenCalledWith(
        'devdocket.editItem',
        'Edit: My Task',
        ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
    });

    it('should push a disposable onto context.subscriptions', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const ctx = openPanel(item, createMockWorkGraph(item), mock);

      expect(ctx.subscriptions.length).toBe(1);
      expect(typeof ctx.subscriptions[0].dispose).toBe('function');
    });

    it('should register a message handler on the webview', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(1);
    });

    it('should register a dispose handler on the panel', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.onDidDispose).toHaveBeenCalledTimes(1);
    });

    it('should pass provider description to HTML when discovered item has one', () => {
      const item = makeItem({ providerId: 'gh', externalId: '42' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '42', title: 'Bug', description: 'Fix the login page' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      expect(registry.getDiscoveredItems).toHaveBeenCalledWith('gh');
      expect(mock.panel.webview.html).toContain('Fix the login page');
    });

    it('should pass provider state to HTML when discovered item has state', () => {
      const item = makeItem({ providerId: 'gh', externalId: '42' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '42', title: 'Bug', state: 'open' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      expect(mock.panel.webview.html).toContain('Provider State');
      expect(mock.panel.webview.html).toContain('open');
    });

    it('should omit provider state from HTML when discovered item has no state', () => {
      const item = makeItem({ providerId: 'gh', externalId: '42' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '42', title: 'Bug' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      expect(mock.panel.webview.html).not.toContain('Provider State');
    });

    it('should display live provider title instead of persisted title', () => {
      const item = makeItem({ title: 'Old Title', providerId: 'gh', externalId: '42' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '42', title: 'Updated Live Title', url: '' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      expect(mock.panel.title).toBe('Edit: Updated Live Title');
      expect(mock.panel.webview.html).toContain('Updated Live Title');
    });

    it('should fall back to persisted title when provider item is not found', () => {
      const item = makeItem({ title: 'Persisted Title', providerId: 'gh', externalId: '42' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      expect(mock.panel.title).toBe('Edit: Persisted Title');
      expect(mock.panel.webview.html).toContain('Persisted Title');
    });

    it('should use persisted title for manual items (no providerId)', () => {
      const item = makeItem({ title: 'Manual Item' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.title).toBe('Edit: Manual Item');
      expect(mock.panel.webview.html).toContain('Manual Item');
    });
  });

  describe('dynamic title updates', () => {
    it('should update title when provider discovers new title', () => {
      const item = makeItem({ title: 'Original', providerId: 'gh', externalId: '10' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '10', title: 'Original', url: '' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      // Simulate provider refresh with new title
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '10', title: 'Renamed Issue', url: '' } as any,
      ]);
      registry._fireDiscoveredItemsChange();

      expect(mock.panel.title).toBe('Edit: Renamed Issue');
      expect(mock.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'updateTitle',
        title: 'Renamed Issue',
      });
    });

    it('should not post message when title has not changed', () => {
      const item = makeItem({ title: 'Stable Title', providerId: 'gh', externalId: '10' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '10', title: 'Stable Title', url: '' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      // Fire change but title is the same
      registry._fireDiscoveredItemsChange();

      expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
    });

    it('should skip title update for non-provider items', () => {
      const item = makeItem({ title: 'Manual', providerId: undefined });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      registry._fireDiscoveredItemsChange();

      expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
    });

    it('should skip title update after panel is disposed', () => {
      const item = makeItem({ title: 'Disposed', providerId: 'gh', externalId: '10' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '10', title: 'Disposed', url: '' } as any,
      ]);
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      // Dispose the panel
      mock.simulateDispose();

      // Now fire a title change
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([
        { externalId: '10', title: 'New Title', url: '' } as any,
      ]);
      registry._fireDiscoveredItemsChange();

      expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
    });
    it('should reuse existing panel when opening same item twice', () => {
      const item = makeItem({ id: 'reuse-1', title: 'Reuse Item' });
      const mock = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);

      const ctx = createMockContext();
      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);
      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

      expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
      expect(mock.panel.reveal).toHaveBeenCalled();
    });

    it('should create separate panels for different items', () => {
      const item1 = makeItem({ id: 'a', title: 'Item A' });
      const item2 = makeItem({ id: 'b', title: 'Item B' });
      const mock1 = createMockWebviewPanel();
      const mock2 = createMockWebviewPanel();
      const wg1 = createMockWorkGraph(item1);
      const wg2 = createMockWorkGraph(item2);

      vi.mocked(window.createWebviewPanel)
        .mockReturnValueOnce(mock1.panel as any)
        .mockReturnValueOnce(mock2.panel as any);

      const ctx = createMockContext();
      WorkItemEditorPanel.open(ctx, wg1 as any, createMockProviderRegistry() as any, item1);
      WorkItemEditorPanel.open(ctx, wg2 as any, createMockProviderRegistry() as any, item2);

      expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
    });

    it('should create new panel after previous one was disposed', () => {
      const item = makeItem({ id: 'dispose-reopen', title: 'Dispose Item' });
      const mock1 = createMockWebviewPanel();
      const mock2 = createMockWebviewPanel();

      vi.mocked(window.createWebviewPanel)
        .mockReturnValueOnce(mock1.panel as any)
        .mockReturnValueOnce(mock2.panel as any);

      const ctx = createMockContext();
      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);
      mock1.simulateDispose();
      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

      expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
    });

    it('should reveal the existing panel on second open', () => {
      const item = makeItem({ id: 'reveal-1', title: 'Reveal Item' });
      const mock = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);

      const ctx = createMockContext();
      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

      expect(mock.panel.reveal).not.toHaveBeenCalled();

      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

      expect(mock.panel.reveal).toHaveBeenCalledTimes(1);
      expect(mock.panel.reveal).toHaveBeenCalledWith();
    });

    it('should allow reopening after dispose() via context subscription', () => {
      const item = makeItem({ id: 'ctx-dispose', title: 'Context Dispose' });
      const mock1 = createMockWebviewPanel();
      const mock2 = createMockWebviewPanel();

      vi.mocked(window.createWebviewPanel)
        .mockReturnValueOnce(mock1.panel as any)
        .mockReturnValueOnce(mock2.panel as any);

      const ctx = createMockContext();
      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

      // Dispose via context subscription (the dispose() method path)
      ctx.subscriptions[ctx.subscriptions.length - 1].dispose();

      WorkItemEditorPanel.open(ctx, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

      expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
    });

    it('should refresh content when reusing an existing panel', () => {
      const item = makeItem({ id: 'refresh-1', title: 'Original Title', notes: 'Original Notes' });
      const mock = createMockWebviewPanel();
      const wg = createMockWorkGraph(item);
      vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);

      const ctx = createMockContext();
      WorkItemEditorPanel.open(ctx, wg as any, createMockProviderRegistry() as any, item);

      // Simulate the item being updated in the work graph
      const updatedItem = makeItem({ id: 'refresh-1', title: 'Updated Title', notes: 'Updated Notes' });
      vi.mocked(wg.getItem).mockReturnValue(updatedItem);
      WorkItemEditorPanel.open(ctx, wg as any, createMockProviderRegistry() as any, updatedItem);

      expect(mock.panel.title).toBe('Edit: Updated Title');
      expect(mock.panel.webview.html).toContain('Updated Title');
    });
  });

  describe('HTML generation', () => {
    it('should render HTML with item title and notes', () => {
      const item = makeItem({ title: 'My Title', notes: 'My Notes' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('My Title');
      expect(mock.panel.webview.html).toContain('My Notes');
    });

    it('should render "Item not found" when item does not exist', () => {
      const item = makeItem({ id: 'missing' });
      const mock = createMockWebviewPanel();
      const workGraph = createMockWorkGraph(); // no item configured
      openPanel(item, workGraph, mock);

      expect(mock.panel.webview.html).toContain('Item not found');
    });

    it('should render readonly title when provider is registered', () => {
      const item = makeItem({ providerId: 'github', externalId: 'ext-1' });
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      openPanel(item, createMockWorkGraph(item), mock, undefined, registry);

      expect(mock.panel.webview.html).toMatch(/<input\b(?=[^>]*\bid="title")(?=[^>]*\breadonly)[^>]*>/);
      expect(mock.panel.webview.html).toContain('Title is managed by the provider');
    });

    it('should not render readonly for non-provider items', () => {
      const item = makeItem({ providerId: undefined });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).not.toContain('Title is managed by the provider');
    });

    it('should escape HTML special characters in notes', () => {
      const item = makeItem({ notes: '<script>alert("xss")</script>' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).not.toContain('<script>alert');
      expect(mock.panel.webview.html).toContain('&lt;script&gt;');
    });

    it('should escape special characters in title attribute', () => {
      const item = makeItem({ title: 'Item "with" <quotes>' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('&quot;with&quot;');
      expect(mock.panel.webview.html).toContain('&lt;quotes&gt;');
    });

    it('should render empty textarea for item with no notes', () => {
      const item = makeItem({ notes: undefined });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('<textarea id="notes" placeholder="Add notes..."></textarea>');
    });

    it('should include a nonce and CSP meta tag', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('Content-Security-Policy');
      expect(mock.panel.webview.html).toContain('nonce-');
      expect(mock.panel.webview.html).toContain(mock.panel.webview.cspSource);
    });

    it('should handle very long notes', () => {
      const longNotes = 'A'.repeat(10000);
      const item = makeItem({ notes: longNotes });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain(longNotes);
    });
  });

  describe('message handling (openUrl)', () => {
    it('should open external URL when openUrl message is received', () => {
      const item = makeItem({ url: 'https://github.com/org/repo/issues/42' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({ type: 'openUrl', url: 'https://github.com/org/repo/issues/42' });

      expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://github.com/org/repo/issues/42');
    });

    it('should not call openExternal when url is not a string', () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({ type: 'openUrl', url: 123 });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('should not call openExternal for javascript: URL', () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({ type: 'openUrl', url: 'javascript:alert(1)' });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('should not call openExternal for data: URL', () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({ type: 'openUrl', url: 'data:text/html,<h1>hi</h1>' });

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('message handling (autosave)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should save title and notes on autosave message', async () => {
      const item = makeItem({ title: 'Old Title' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'New Title', notes: 'Some notes' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        title: 'New Title',
        notes: 'Some notes',
      });
    });

    it('should update panel title for non-provider items', async () => {
      const item = makeItem({ title: 'Old Title', providerId: undefined });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Updated Title', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(mock.panel.title).toBe('Edit: Updated Title');
    });

    it('should not update panel title for provider-managed items', async () => {
      const item = makeItem({ title: 'Provider Title', providerId: 'github', externalId: 'ext-1' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([{ externalId: 'ext-1', title: 'Provider Title', url: '' }]);
      openPanel(item, workGraph, mock, undefined, registry);
      mock.panel.title = 'Edit: Provider Title';

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Provider Title', notes: 'new note' },
      });
      await vi.advanceTimersByTimeAsync(300);

      // Title should not change for provider items (title not in patch)
      expect(mock.panel.title).toBe('Edit: Provider Title');
    });

    it('should skip save when title is empty for non-provider items', async () => {
      const item = makeItem({ providerId: undefined });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: '', notes: 'Some notes' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).not.toHaveBeenCalled();
    });

    it('should save notes only for provider-managed items', async () => {
      const item = makeItem({ providerId: 'github', title: 'Provider Item', externalId: 'ext-1' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([{ externalId: 'ext-1', title: 'Provider Item', url: '' }]);
      openPanel(item, workGraph, mock, undefined, registry);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Provider Item', notes: 'Updated notes' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        notes: 'Updated notes',
      });
    });

    it('should set notes to undefined when notes field is empty string', async () => {
      const item = makeItem({ notes: 'old notes' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Test item', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        title: 'Test item',
        notes: undefined,
      });
    });

    it('should show error message when item no longer exists during save', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      // Make item disappear after panel was created
      workGraph.getItem.mockReturnValue(undefined);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'New', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('no longer exists'),
      );
    });

    it('should show error message when updateItem throws', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      workGraph.updateItem.mockRejectedValue(new Error('disk full'));

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Test item', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('disk full'),
      );
    });

    it('should handle non-Error thrown values in error message', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      workGraph.updateItem.mockRejectedValue('string error');

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Test item', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('string error'),
      );
    });

    it('should ignore messages with unknown type', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({ type: 'unknown', data: {} });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).not.toHaveBeenCalled();
    });

    it('should not call updateItem when patch is empty (provider-managed item with no notes change)', async () => {
      const item = makeItem({ providerId: 'github', title: 'Provider Item', externalId: 'ext-1' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([{ externalId: 'ext-1', title: 'Provider Item', url: '' }]);
      openPanel(item, workGraph, mock, undefined, registry);

      // Simulate message without 'notes' key in data
      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Provider Item' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).not.toHaveBeenCalled();
    });

    it('should debounce rapid autosave messages and only save the latest', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'First', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(100);

      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Second', notes: 'final notes' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        title: 'Second',
        notes: 'final notes',
      });
    });
  });

  describe('disposal', () => {
    it('should dispose message subscription when panel is disposed via onDidDispose', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const msgDisposable = { dispose: vi.fn() };
      mock.panel.webview.onDidReceiveMessage.mockReturnValue(msgDisposable);

      openPanel(item, createMockWorkGraph(item), mock);
      mock.simulateDispose();

      expect(msgDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose panel and subscription when dispose() is called via context', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const msgDisposable = { dispose: vi.fn() };
      mock.panel.webview.onDidReceiveMessage.mockReturnValue(msgDisposable);

      const ctx = openPanel(item, createMockWorkGraph(item), mock);
      ctx.subscriptions[0].dispose();

      expect(msgDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(mock.panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call dispose multiple times', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const msgDisposable = { dispose: vi.fn() };
      mock.panel.webview.onDidReceiveMessage.mockReturnValue(msgDisposable);

      const ctx = openPanel(item, createMockWorkGraph(item), mock);

      // Dispose via context, then simulate panel dispose
      ctx.subscriptions[0].dispose();
      mock.simulateDispose();

      expect(msgDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(mock.panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('should not update panel title after disposal', async () => {
      vi.useFakeTimers();
      const item = makeItem({ title: 'Original' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      // Dispose first
      mock.simulateDispose();
      mock.panel.title = 'Edit: Original';

      // Then try to save
      mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Changed', notes: '' },
      });
      await vi.advanceTimersByTimeAsync(300);

      // Title should remain unchanged because panel is disposed
      expect(mock.panel.title).toBe('Edit: Original');
      vi.useRealTimers();
    });
  });

  describe('special characters and edge cases', () => {
    it('should handle ampersands in title', () => {
      const item = makeItem({ title: 'Tom & Jerry' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('Tom &amp; Jerry');
    });

    it('should handle double quotes in title', () => {
      const item = makeItem({ title: 'Say "hello"' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('Say &quot;hello&quot;');
    });

    it('should handle special characters in notes', () => {
      const item = makeItem({ notes: 'a < b && c > d' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('a &lt; b &amp;&amp; c &gt; d');
    });

    it('should include autosave script in HTML output', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('scheduleAutosave');
      expect(mock.panel.webview.html).toContain('acquireVsCodeApi');
    });
  });

  describe('concurrent autosave', () => {
    let item: WorkItem;
    let workGraph: ReturnType<typeof createMockWorkGraph>;
    let mock: ReturnType<typeof createMockWebviewPanel>;

    function simulateAutosave(data: { title: string; notes: string }) {
      return mock.simulateMessage({ type: 'autosave', data });
    }

    beforeEach(() => {
      vi.clearAllMocks();
      vi.useFakeTimers();
      item = makeItem();
      workGraph = createMockWorkGraph(item);
      // Override updateItem to actually apply patches so race-condition tests work
      workGraph.updateItem.mockImplementation(async (_id: string, patch: any) => {
        if (patch.title !== undefined) {
          item.title = patch.title;
        }
        if ('notes' in patch) {
          item.notes = patch.notes;
        }
      });
      mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('saves each sequential autosave message that reaches the backend', async () => {
      simulateAutosave({ title: 'A', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'AB', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'ABC', notes: '' });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledTimes(3);
      expect(workGraph.updateItem).toHaveBeenNthCalledWith(1, 'item-1', expect.objectContaining({ title: 'A' }));
      expect(workGraph.updateItem).toHaveBeenNthCalledWith(2, 'item-1', expect.objectContaining({ title: 'AB' }));
      expect(workGraph.updateItem).toHaveBeenNthCalledWith(3, 'item-1', expect.objectContaining({ title: 'ABC' }));
    });

    // TODO: Once sequencing/cancellation is implemented, this should assert
    // that the newest value ('v2') persists regardless of resolution order.
    it.todo('preserves the newest autosave value when saves resolve out of order');

    it('debounces rapid messages and only saves the last value', async () => {
      simulateAutosave({ title: 'v1', notes: '' });
      simulateAutosave({ title: 'v2', notes: '' });

      // No save yet during the debounce window
      expect(workGraph.updateItem).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
      expect(workGraph.updateItem).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({ title: 'v2' }),
      );
    });

    it('processes every autosave message when spaced beyond debounce window', async () => {
      simulateAutosave({ title: 'v1', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'v2', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'v3', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'v4', notes: '' });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledTimes(4);
    });

    it('handles interleaved title and notes updates', async () => {
      simulateAutosave({ title: 'T1', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'T1', notes: 'N1' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'T2', notes: 'N1' });
      await vi.advanceTimersByTimeAsync(300);
      simulateAutosave({ title: 'T2', notes: 'N2' });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledTimes(4);
      expect(workGraph.updateItem).toHaveBeenLastCalledWith('item-1', { title: 'T2', notes: 'N2' });
    });

    it('debounces saves by 300ms before flushing', async () => {
      simulateAutosave({ title: 'fast', notes: '' });
      expect(workGraph.updateItem).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);

      simulateAutosave({ title: 'faster', notes: '' });
      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300);
      expect(workGraph.updateItem).toHaveBeenCalledTimes(2);
    });

    it('uses last value wins semantics after a burst of updates', async () => {
      simulateAutosave({ title: 'draft-1', notes: '' });
      simulateAutosave({ title: 'draft-2', notes: '' });
      simulateAutosave({ title: 'final', notes: '' });
      await vi.advanceTimersByTimeAsync(300);

      // Debounce coalesces the burst — only the last value is saved
      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
      const lastPatch = workGraph.updateItem.mock.calls.at(-1)![1];
      expect(lastPatch.title).toBe('final');
      expect(item.title).toBe('final');
    });

    it('does not crash or save when a message arrives after disposal', async () => {
      simulateAutosave({ title: 'before dispose', notes: '' });
      await vi.advanceTimersByTimeAsync(300);
      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);

      mock.simulateDispose();

      // Message handler is cleared on disposal, so this is a no-op
      simulateAutosave({ title: 'too late', notes: '' });
      await vi.advanceTimersByTimeAsync(300);

      expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
    });
  });
});

describe('WorkItemEditorPanel (integration with WorkGraph)', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let mockPanel: ReturnType<typeof createIntegrationWebviewPanel>;
  let context: vscode.ExtensionContext;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    context = createIntegrationContext();
    mockPanel = createIntegrationWebviewPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReset();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel as any);
    vi.mocked(vscode.window.showErrorMessage).mockReset();
  });

  describe('open', () => {
    it('creates a webview panel with correct type and title', async () => {
      const item = await graph.createItem({ title: 'My Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'devdocket.editItem',
        `Edit: My Task`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
    });

    it('adds a disposable to context subscriptions', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      expect(context.subscriptions.length).toBe(1);
      expect(context.subscriptions[0]).toHaveProperty('dispose');
    });

    it('sets webview HTML on creation', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      expect(mockPanel.webview.html).not.toContain('Edit Work Item');
      expect(mockPanel.webview.html).toContain('Task');
      expect(mockPanel.webview.html).toContain('id="editor-heading"');
    });
  });

  describe('HTML generation', () => {
    it('title field is readonly when provider is registered', async () => {
      const item = await graph.createItem(
        { title: 'Provider Task' },
        { providerId: 'github', externalId: '42' },
      );
      const registry = createMockProviderRegistry();
      WorkItemEditorPanel.open(context, graph, registry as any, item);

      const html = mockPanel.webview.html;
      const titleMatch = html.match(/<input[^>]*id="title"[^>]*>/);
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![0]).toContain('readonly');
      expect(html).toContain('Title is managed by the provider');
    });

    it('title field is editable for manual items', async () => {
      const item = await graph.createItem({ title: 'Manual Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      const titleMatch = html.match(/<input[^>]*id="title"[^>]*>/);
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![0]).not.toContain('readonly');
      expect(html).not.toContain('Title is managed by the provider');
    });

    it('title field is editable for unregistered provider IDs', async () => {
      const item = await graph.createItem(
        { title: 'Imported Task' },
        { providerId: 'non-existent-provider', externalId: 'https://example.com/pr/1' },
      );
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getProvider).mockReturnValue(undefined);
      WorkItemEditorPanel.open(context, graph, registry as any, item);

      const html = mockPanel.webview.html;
      const titleMatch = html.match(/<input[^>]*id="title"[^>]*>/);
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![0]).not.toContain('readonly');
      expect(html).not.toContain('Title is managed by the provider');
    });

    it('title field is readonly when provider is registered even if item is not discovered', async () => {
      const item = await graph.createItem(
        { title: 'URL Imported PR' },
        { providerId: 'github', externalId: 'owner/repo#999' },
      );
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([]);
      WorkItemEditorPanel.open(context, graph, registry as any, item);

      const html = mockPanel.webview.html;
      const titleMatch = html.match(/<input[^>]*id="title"[^>]*>/);
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![0]).toContain('readonly');
      expect(html).toContain('Title is managed by the provider');
    });

    it('notes field is always editable', async () => {
      const item = await graph.createItem(
        { title: 'Provider Task' },
        { providerId: 'github', externalId: '42' },
      );
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      const notesMatch = html.match(/<textarea[^>]*id="notes"[^>]*>/);
      expect(notesMatch).toBeTruthy();
      expect(notesMatch![0]).not.toContain('readonly');
    });

    it('CSP meta tag includes nonce', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/);
    });

    it('script tag includes nonce', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      expect(html).toMatch(/<script nonce="[A-Za-z0-9]+">/);
    });

    it('CSP includes webview cspSource', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      expect(mockPanel.webview.html).toContain('mock-csp-source');
    });

    it('shows "Item not found" when item is missing', () => {
      const fakeItem = makeItem({ id: 'nonexistent' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, fakeItem);

      expect(mockPanel.webview.html).toContain('Item not found.');
    });
  });

  describe('HTML escaping', () => {
    it('escapes special characters in title', async () => {
      const item = await graph.createItem({ title: 'A & B <script>"alert"</script>' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      expect(html).toContain('&amp;');
      expect(html).toContain('&lt;');
      expect(html).toContain('&gt;');
      expect(html).toContain('&quot;');
      expect(html).not.toMatch(/value="[^"]*<script>/);
    });

    it('escapes special characters in notes', async () => {
      const item = await graph.createItem({ title: 'Task', notes: '<b>bold</b> & "quotes"' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
      expect(html).toContain('&amp;');
    });

    it('renders empty notes without error', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const html = mockPanel.webview.html;
      expect(html).toMatch(/<textarea id="notes" placeholder="Add notes..."><\/textarea>/);
    });
  });

  describe('saveData via autosave message', () => {
    it('updates title and notes for manual items', async () => {
      const item = await graph.createItem({ title: 'Original' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Updated Title', notes: 'Some notes' },
      });

      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.title).toBe('Updated Title');
        expect(updated!.notes).toBe('Some notes');
      });
    });

    it('updates panel title after saving for manual items', async () => {
      const item = await graph.createItem({ title: 'Original' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'New Title', notes: '' },
      });

      await vi.waitFor(() => {
        expect(mockPanel.title).toBe('Edit: New Title');
      });
    });

    it('ignores autosave with empty title for manual items', async () => {
      const item = await graph.createItem({ title: 'Original' });
      const saveCountBefore = vi.mocked(store.save).mock.calls.length;
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: '', notes: 'notes' },
      });

      await Promise.resolve();
      expect(vi.mocked(store.save)).toHaveBeenCalledTimes(saveCountBefore);
      expect(graph.getItem(item.id)!.title).toBe('Original');
    });

    it('provider-managed items cannot change title, only notes', async () => {
      const item = await graph.createItem(
        { title: 'Provider Title' },
        { providerId: 'github', externalId: '99' },
      );
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([{ externalId: '99', title: 'Provider Title', url: '' }]);
      WorkItemEditorPanel.open(context, graph, registry as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Attempted Change', notes: 'My notes' },
      });

      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.title).toBe('Provider Title');
        expect(updated!.notes).toBe('My notes');
      });
    });

    it('registered-but-not-discovered provider items are read-only', async () => {
      const item = await graph.createItem(
        { title: 'Original Title' },
        { providerId: 'github', externalId: 'owner/repo#999' },
      );
      // Provider is registered but has not discovered this item — still read-only
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Attempted Change', notes: 'My notes' },
      });

      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.title).toBe('Original Title');
        expect(updated!.notes).toBe('My notes');
      });
    });

    it('shows error when item no longer exists', async () => {
      const item = await graph.createItem({ title: 'Temp' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      await graph.deleteItem(item.id);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Updated', notes: '' },
      });

      await vi.waitFor(() => {
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('no longer exists'),
        );
      });
    });

    it('clears notes when empty string is sent', async () => {
      const item = await graph.createItem({ title: 'Task', notes: 'old notes' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Task', notes: '' },
      });

      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.notes).toBeUndefined();
      });
    });

    it('skips save when provider-managed item patch is empty', async () => {
      const item = await graph.createItem(
        { title: 'Provider' },
        { providerId: 'github', externalId: '1' },
      );
      const saveCountBefore = vi.mocked(store.save).mock.calls.length;
      const registry = createMockProviderRegistry();
      vi.mocked(registry.getDiscoveredItems).mockReturnValue([{ externalId: '1', title: 'Provider', url: '' }]);
      WorkItemEditorPanel.open(context, graph, registry as any, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Provider' },
      });

      await vi.waitFor(() => {
        expect(vi.mocked(store.save)).toHaveBeenCalledTimes(saveCountBefore);
      });
    });

    it('ignores unknown message types', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      expect(() => {
        mockPanel.webview._fireMessage({ type: 'unknown', data: {} });
      }).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('dispose via context subscription cleans up panel', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const sub = context.subscriptions[0] as vscode.Disposable;
      sub.dispose();

      expect(mockPanel.dispose).toHaveBeenCalled();
    });

    it('dispose via onDidDispose cleans up message subscription', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const msgDisposable = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.results[0].value;

      mockPanel._fireDispose();

      expect(msgDisposable.dispose).toHaveBeenCalled();
    });

    it('double dispose is safe', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, createMockProviderRegistry() as any, item);

      const sub = context.subscriptions[0] as vscode.Disposable;
      sub.dispose();
      expect(() => sub.dispose()).not.toThrow();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter } from 'vscode';
import { IncomingPreviewPanel } from '../views/incomingPreviewPanel';
import { WatchPanelProvider } from '../views/watchPanelProvider';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { WorkItem, WorkItemState } from '../models/workItem';

type MessageHandler = (message: unknown) => void | Promise<void>;
type DisposeHandler = () => void;

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Restored work item',
    state: WorkItemState.New,
    createdAt: now,
    updatedAt: now,
    activityLog: [],
    ...overrides,
  };
}

function createContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('C:\\repo\\packages\\core'),
  } as unknown as vscode.ExtensionContext;
}

function createMockWebviewPanel() {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: DisposeHandler | undefined;
  const panel = {
    title: '',
    active: false,
    webview: {
      html: '',
      options: undefined as vscode.WebviewOptions | undefined,
      cspSource: 'mock-csp-source',
      asWebviewUri: vi.fn((uri: { fsPath?: string; path?: string; toString?: () => string }) => ({
        toString: () => `webview-resource:${uri.fsPath ?? uri.path ?? uri.toString?.() ?? ''}`,
      })),
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
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(() => disposeHandler?.()),
    reveal: vi.fn(),
  };

  return {
    panel,
    simulateMessage: (message: unknown) => messageHandler?.(message) ?? Promise.resolve(),
    simulateDispose: () => disposeHandler?.(),
  };
}

function createMockWorkGraph(items: WorkItem[] = []) {
  const changeEmitter = new EventEmitter<void>();
  const itemMap = new Map(items.map(item => [item.id, item]));
  return {
    getAll: vi.fn(() => Array.from(itemMap.values())),
    getItem: vi.fn((id: string) => itemMap.get(id)),
    findItemByProvenance: vi.fn((providerId: string, externalId: string) =>
      Array.from(itemMap.values()).find(item => item.providerId === providerId && item.externalId === externalId)),
    onDidChange: changeEmitter.event,
  };
}

function createMockProviderRegistry(providerItems: Record<string, any[]> = {}) {
  const providerItemsEmitter = new EventEmitter<void>();
  const providerRefreshEmitter = new EventEmitter<string>();
  const registerEmitter = new EventEmitter<void>();
  const registry: any = {
    getProviderItems: vi.fn((providerId: string) => providerItems[providerId] ?? []),
    getAllProviderItems: vi.fn(() => new Map(Object.entries(providerItems))),
    getProvider: vi.fn((providerId: string) => providerId ? { id: providerId, label: providerId } : undefined),
    getProviderLabel: vi.fn((providerId: string) => providerId === 'github' ? 'GitHub' : providerId),
    onDidChangeProviderItems: providerItemsEmitter.event,
    onDidRefreshProvider: providerRefreshEmitter.event,
    onDidRegisterProvider: registerEmitter.event,
    fireProviderItemsChanged: () => providerItemsEmitter.fire(),
    fireProviderRefreshed: (providerId: string) => providerRefreshEmitter.fire(providerId),
  };
  registry.findProviderItem = vi.fn((providerId: string, externalId: string) =>
    registry.getProviderItems(providerId).find((item: any) => item.externalId === externalId));
  return registry;
}

function createMockInboxStateStore() {
  const changeEmitter = new EventEmitter<void>();
  return {
    getState: vi.fn(() => 'unseen'),
    setState: vi.fn(async () => undefined),
    onDidChange: changeEmitter.event,
  };
}

function createMockReadStateStore() {
  return {
    add: vi.fn(async () => undefined),
  };
}

function createMockWatcherService() {
  return {
    getActivePRWatches: vi.fn(() => []),
    getActiveStandaloneWatches: vi.fn(() => []),
    getActiveWatches: vi.fn(() => []),
    getPRWatchKey: vi.fn(),
    getChildRuns: vi.fn(() => []),
    getProviderLabel: vi.fn(),
    acknowledgeAllFailures: vi.fn(),
    dismissPRWatch: vi.fn(),
    dismissWatch: vi.fn(),
  };
}

describe('webview panel serializers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WorkItemEditorPanel.clearPanelCache();
  });

  it('restores a work item editor panel from serialized item state', async () => {
    const context = createContext();
    const item = makeItem({ providerId: 'github', externalId: 'owner/repo#1' });
    const workGraph = createMockWorkGraph([item]);
    const providerRegistry = createMockProviderRegistry();
    const mockPanel = createMockWebviewPanel();

    const serializer = WorkItemEditorPanel.createSerializer(context, workGraph as any, providerRegistry as any);
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 1, itemId: item.id });

    expect(mockPanel.panel.title).toBe('Edit: Restored work item');
    expect(mockPanel.panel.webview.options).toMatchObject({ enableScripts: true });
    expect(mockPanel.panel.webview.html).toContain('Restored work item');
    expect(mockPanel.panel.webview.onDidReceiveMessage).toHaveBeenCalled();
  });

  it('shows a hardened unavailable page when work item editor state is invalid', async () => {
    const context = createContext();
    const mockPanel = createMockWebviewPanel();

    const serializer = WorkItemEditorPanel.createSerializer(
      context,
      createMockWorkGraph() as any,
      createMockProviderRegistry() as any,
    );
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 2, itemId: 'item-1' });

    expect(mockPanel.panel.title).toBe('Work item unavailable');
    expect(mockPanel.panel.webview.html).toContain("default-src 'none'");
    expect(mockPanel.panel.webview.html).toContain('Work item editor state is unavailable');
  });

  it('restores an incoming preview after provider items are available', async () => {
    const context = createContext();
    const providerItems = {
      github: [{ externalId: 'owner/repo#2', title: 'Restored incoming item', description: 'Incoming description', itemType: 'issue' }],
    };
    const providerRegistry = createMockProviderRegistry(providerItems);
    const mockPanel = createMockWebviewPanel();

    const serializer = IncomingPreviewPanel.createSerializer(
      context,
      providerRegistry as any,
      createMockInboxStateStore() as any,
      createMockReadStateStore() as any,
      createMockWorkGraph() as any,
    );
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 1, providerId: 'github', externalId: 'owner/repo#2' });

    expect(mockPanel.panel.title).toBe('Preview: Restored incoming item');
    expect(mockPanel.panel.webview.options).toMatchObject({ enableScripts: true });
    expect(mockPanel.panel.webview.html).toContain('Restored incoming item');
    expect(mockPanel.panel.webview.onDidReceiveMessage).toHaveBeenCalled();
  });

  it('keeps a restored incoming preview alive while waiting for provider refresh', async () => {
    const context = createContext();
    const providerItems: Record<string, any[]> = { github: [] };
    const providerRegistry = createMockProviderRegistry(providerItems);
    const mockPanel = createMockWebviewPanel();

    const serializer = IncomingPreviewPanel.createSerializer(
      context,
      providerRegistry as any,
      createMockInboxStateStore() as any,
      createMockReadStateStore() as any,
      createMockWorkGraph() as any,
    );
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 1, providerId: 'github', externalId: 'owner/repo#3' });

    expect(mockPanel.panel.title).toBe('Preview: Loading…');
    expect(mockPanel.panel.dispose).not.toHaveBeenCalled();
    expect(mockPanel.panel.webview.html).toContain('Loading incoming item from provider');

    providerItems.github = [{ externalId: 'owner/repo#3', title: 'Eventually restored item', itemType: 'issue' }];
    providerRegistry.fireProviderItemsChanged();

    expect(mockPanel.panel.title).toBe('Preview: Eventually restored item');
    expect(mockPanel.panel.webview.html).toContain('Eventually restored item');
  });

  it('shows an unavailable message when a restored incoming preview is still missing after refresh', async () => {
    const context = createContext();
    const providerRegistry = createMockProviderRegistry({ github: [] });
    const mockPanel = createMockWebviewPanel();

    const serializer = IncomingPreviewPanel.createSerializer(
      context,
      providerRegistry as any,
      createMockInboxStateStore() as any,
      createMockReadStateStore() as any,
      createMockWorkGraph() as any,
    );
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 1, providerId: 'github', externalId: 'owner/repo#4' });

    providerRegistry.fireProviderRefreshed('github');

    expect(mockPanel.panel.title).toBe('Preview unavailable');
    expect(mockPanel.panel.dispose).not.toHaveBeenCalled();
    expect(mockPanel.panel.webview.html).toContain('not found after the provider refreshed');
    expect(mockPanel.panel.webview.html).toContain('window.__DEVDOCKET_VSCODE_API__.setState');
  });

  it('shows a hardened unavailable page when incoming preview state is invalid', async () => {
    const context = createContext();
    const mockPanel = createMockWebviewPanel();

    const serializer = IncomingPreviewPanel.createSerializer(
      context,
      createMockProviderRegistry() as any,
      createMockInboxStateStore() as any,
      createMockReadStateStore() as any,
      createMockWorkGraph() as any,
    );
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 2, providerId: 'github', externalId: 'owner/repo#5' });

    expect(mockPanel.panel.title).toBe('Incoming preview unavailable');
    expect(mockPanel.panel.webview.html).toContain("default-src 'none'");
    expect(mockPanel.panel.webview.html).toContain('Incoming preview state is unavailable');
  });

  it('restores the CI watches panel and posts the current watch snapshot', async () => {
    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo\\packages\\core') as any,
      createMockWatcherService() as any,
      createMockWorkGraph() as any,
      createMockProviderRegistry() as any,
    );
    const mockPanel = createMockWebviewPanel();

    const serializer = provider.createSerializer();
    await serializer.deserializeWebviewPanel(mockPanel.panel as any, { version: 1, panel: 'watchPanel' });

    expect(mockPanel.panel.title).toBe('CI Watches');
    expect(mockPanel.panel.webview.options).toMatchObject({ enableScripts: true });
    expect(mockPanel.panel.webview.html).toContain('watchPanel.js');
    expect(mockPanel.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'updateWatchPanel',
      prWatches: [],
      runWatches: [],
    });
  });
});

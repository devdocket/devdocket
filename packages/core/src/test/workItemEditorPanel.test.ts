import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ViewColumn, window } from 'vscode';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { WorkItem, WorkItemState } from '../models/workItem';

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Test item',
    state: WorkItemState.New,
    notes: 'notes',
    createdAt: now,
    updatedAt: now,
    activityLog: [],
    ...overrides,
  };
}

type MessageHandler = (message: unknown) => void | Promise<void>;
type DisposeHandler = () => void;

function createMockWebviewPanel() {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: DisposeHandler | undefined;
  const panel = {
    title: '',
    webview: {
      html: '',
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
    dispose: vi.fn(),
    reveal: vi.fn(),
  };

  return {
    panel,
    simulateMessage: (message: unknown) => messageHandler?.(message) ?? Promise.resolve(),
    simulateDispose: () => disposeHandler?.(),
  };
}

function createMockWorkGraph(primaryItem?: WorkItem, relatedByProvenance: Record<string, WorkItem> = {}) {
  const changeEmitter = new EventEmitter<void>();
  const items = new Map<string, WorkItem>();
  if (primaryItem) {
    items.set(primaryItem.id, { ...primaryItem });
  }
  for (const item of Object.values(relatedByProvenance)) {
    items.set(item.id, { ...item });
  }

  return {
    getItem: vi.fn((id: string) => items.get(id)),
    updateItem: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const current = items.get(id);
      if (!current) {
        throw new Error(`Missing item ${id}`);
      }
      items.set(id, { ...current, ...patch, updatedAt: Date.now() });
      changeEmitter.fire();
    }),
    transitionState: vi.fn(async (id: string, targetState: WorkItemState) => {
      const current = items.get(id);
      if (!current) {
        throw new Error(`Missing item ${id}`);
      }
      items.set(id, { ...current, state: targetState, updatedAt: Date.now() });
      changeEmitter.fire();
    }),
    createItem: vi.fn(async (input: { title: string; description?: string }, provenance?: { providerId: string; externalId: string; url?: string; group?: string }) => {
      const created = makeItem({
        id: `created-${items.size + 1}`,
        title: input.title,
        description: input.description,
        providerId: provenance?.providerId,
        externalId: provenance?.externalId,
        url: provenance?.url,
        group: provenance?.group,
      });
      items.set(created.id, created);
      return created;
    }),
    findItemByProvenance: vi.fn((providerId: string, externalId: string) => relatedByProvenance[`${providerId}::${externalId}`]),
    onDidChange: changeEmitter.event,
    _setItem: (item: WorkItem) => {
      items.set(item.id, { ...item });
    },
    _fireChange: () => changeEmitter.fire(),
  };
}

function createMockProviderRegistry(discoveredByProvider: Record<string, any[]> = {}) {
  const discoveredEmitter = new EventEmitter<void>();
  const registerEmitter = new EventEmitter<void>();

  return {
    getDiscoveredItems: vi.fn((providerId: string) => discoveredByProvider[providerId] ?? []),
    getAllDiscoveredItems: vi.fn(() => new Map(Object.entries(discoveredByProvider))),
    getProvider: vi.fn((providerId: string) => providerId ? { id: providerId, label: providerId } : undefined),
    getProviderLabel: vi.fn((providerId: string) => providerId === 'github' ? 'GitHub' : providerId),
    onDidChangeDiscoveredItems: discoveredEmitter.event,
    onDidRegisterProvider: registerEmitter.event,
    _fireDiscoveredItemsChange: () => discoveredEmitter.fire(),
    _fireRegisterProvider: () => registerEmitter.fire(),
  };
}

function createMockActionRegistry() {
  const changeEmitter = new EventEmitter<void>();
  return {
    hasActionsFor: vi.fn(() => false),
    onDidChangeRegistrations: vi.fn((listener: () => void) => changeEmitter.event(listener)),
    _fireChange: () => changeEmitter.fire(),
  };
}

function createMockStateStore() {
  return {
    setState: vi.fn(async () => undefined),
  };
}

function createMockContext() {
  return {
    extensionUri: vscode.Uri.file('C:\\repos\\devdocket-mission-control-454\\packages\\core'),
    subscriptions: [] as Array<{ dispose(): void }>,
  } as unknown as vscode.ExtensionContext;
}

function openPanel(
  item: WorkItem,
  workGraph = createMockWorkGraph(item),
  providerRegistry = createMockProviderRegistry(),
  actionRegistry = createMockActionRegistry(),
  stateStore = createMockStateStore(),
) {
  const mock = createMockWebviewPanel();
  const context = createMockContext();
  vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);
  WorkItemEditorPanel.setDependencies(actionRegistry as any, stateStore as any);
  WorkItemEditorPanel.open(context, workGraph as any, providerRegistry as any, item, item.providerId ? 'GitHub' : undefined);
  return { mock, context, workGraph, providerRegistry, actionRegistry, stateStore };
}

describe('WorkItemEditorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WorkItemEditorPanel.clearPanelCache();
    WorkItemEditorPanel.setDependencies(undefined, undefined);
    vi.useRealTimers();
  });

  it('creates a webview panel with the editor bundle shell', () => {
    const item = makeItem({ title: 'My Task', notes: 'My notes' });
    const { mock } = openPanel(item);

    expect(window.createWebviewPanel).toHaveBeenCalledWith(
      'devdocket.editItem',
      'Edit: My Task',
      ViewColumn.One,
      expect.objectContaining({
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: expect.any(Array),
      }),
    );
    expect(mock.panel.webview.html).toContain('editor.js');
    expect(mock.panel.webview.html).toContain('__DEVDOCKET_EDITOR_BOOTSTRAP__');
    expect(mock.panel.webview.html).toContain('"title":"My Task"');
    expect(mock.panel.webview.html).toContain('"notes":"My notes"');
  });

  it('posts updateTitle when only the title changes', () => {
    const item = makeItem({ title: 'Original', providerId: 'github', externalId: '42' });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph, createMockProviderRegistry({
      github: [{ externalId: '42', title: 'Original', state: 'open' }],
    }));

    workGraph._setItem({ ...item, title: 'Renamed' });
    workGraph._fireChange();

    expect(mock.panel.title).toBe('Edit: Renamed');
    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith({ type: 'updateTitle', title: 'Renamed' });
  });

  it('posts updateEditorItem with synced description, action transitions, and related items when provider data changes', () => {
    const item = makeItem({
      id: 'item-1',
      title: 'Primary',
      description: '## Updated description',
      providerId: 'github-my-prs',
      externalId: 'owner/repo#42',
      state: WorkItemState.New,
    });
    const peer = makeItem({ id: 'peer-1', title: 'Peer', providerId: 'github-issues', externalId: 'owner/repo#99', state: WorkItemState.InProgress });
    const workGraph = createMockWorkGraph(item, { 'github-issues::owner/repo#99': peer });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }],
      'github-issues': [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue' }],
    });
    const actionRegistry = createMockActionRegistry();
    actionRegistry.hasActionsFor.mockReturnValue(true);
    const { mock } = openPanel(item, workGraph, providerRegistry, actionRegistry);

    providerRegistry.getDiscoveredItems.mockImplementation((providerId: string) => {
      if (providerId === 'github-my-prs') {
        return [{ externalId: 'owner/repo#42', title: 'Primary', state: 'closed', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }];
      }
      return [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue' }];
    });
    providerRegistry.getAllDiscoveredItems.mockImplementation(() => new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#42', title: 'Primary', state: 'closed', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }]],
      ['github-issues', [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue' }]],
    ]));

    providerRegistry._fireDiscoveredItemsChange();

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.objectContaining({
        description: '<h2>Updated description</h2>\n',
        hasActions: true,
        validTransitions: expect.arrayContaining(['InProgress', 'Done', 'Archived']),
        relatedItems: [expect.objectContaining({ targetItemId: 'peer-1', label: 'Closes owner/repo#99' })],
      }),
    }));
  });

  it('debounces autosave and saves manual fields', async () => {
    vi.useFakeTimers();
    const item = makeItem({ title: 'Original' });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    mock.simulateMessage({
      type: 'autosave',
      data: {
        title: ' Updated title ',
        notes: ' Some notes ',
        url: ' https://example.com/items/1 ',
      },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
      title: 'Updated title',
      notes: 'Some notes',
      url: 'https://example.com/items/1',
    });
  });

  it('flushes pending autosave data when the panel is disposed', async () => {
    const item = makeItem({ title: 'Original' });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    mock.simulateMessage({
      type: 'autosave',
      data: {
        title: ' Updated before close ',
        notes: ' Draft notes ',
      },
    });

    mock.simulateDispose();

    await vi.waitFor(() => {
      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        title: 'Updated before close',
        notes: 'Draft notes',
      });
    });
  });

  it('only saves notes for provider-managed items', async () => {
    vi.useFakeTimers();
    const item = makeItem({ providerId: 'github', externalId: '42', title: 'Provider item' });
    const workGraph = createMockWorkGraph(item);
    const providerRegistry = createMockProviderRegistry({
      github: [{ externalId: '42', title: 'Provider item', state: 'open' }],
    });
    const { mock } = openPanel(item, workGraph, providerRegistry);

    mock.simulateMessage({
      type: 'autosave',
      data: { title: 'Attempted change', notes: ' Draft note ' },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', { notes: 'Draft note' });
  });

  it('opens safe external URLs and ignores unsafe ones', async () => {
    const item = makeItem();
    const { mock } = openPanel(item);

    await mock.simulateMessage({ type: 'openUrl', url: 'https://example.com/item/1' });
    await mock.simulateMessage({ type: 'openUrl', url: 'javascript:alert(1)' });

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://example.com/item/1');
  });

  it('forwards state transitions and commands from the editor', async () => {
    const item = makeItem({ state: WorkItemState.InProgress });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    await mock.simulateMessage({ type: 'transitionState', itemId: item.id, targetState: WorkItemState.Done });
    await mock.simulateMessage({ type: 'runAction', itemId: item.id });
    await mock.simulateMessage({ type: 'openItem', itemId: item.id });

    expect(workGraph.transitionState).toHaveBeenCalledWith(item.id, WorkItemState.Done);
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1, 'devdocket.runAction', { id: item.id });
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, 'devdocket.editItem', { id: item.id });
  });

  it('opens related Sources items from the editor using explicit provenance fields', async () => {
    const item = makeItem({ state: WorkItemState.New });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    await mock.simulateMessage({
      type: 'openItem',
      itemId: 'provider::with-delimiter::external::with-delimiter',
      providerId: 'provider::with-delimiter',
      externalId: 'external::with-delimiter',
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.previewIncomingItem', {
      providerId: 'provider::with-delimiter',
      externalId: 'external::with-delimiter',
    });
  });

  it('ignores malformed explicit provenance fields from related Sources messages', async () => {
    const item = makeItem({ state: WorkItemState.New });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    await mock.simulateMessage({
      type: 'openItem',
      itemId: 'github-issues::owner/repo#99',
      providerId: 123,
      externalId: { value: 'owner/repo#99' },
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.previewIncomingItem', {
      providerId: 'github-issues',
      externalId: 'owner/repo#99',
    });
  });

  it('accepts and dismisses provider items through the shared state store', async () => {
    const item = makeItem({ providerId: 'github', externalId: '42' });
    const workGraph = createMockWorkGraph(item);
    workGraph.findItemByProvenance.mockReturnValue(undefined);
    const providerRegistry = createMockProviderRegistry({
      github: [{ externalId: '99', title: 'Incoming item', description: 'Desc', url: 'https://example.com/99', group: 'repo' }],
    });
    const stateStore = createMockStateStore();
    const { mock } = openPanel(item, workGraph, providerRegistry, createMockActionRegistry(), stateStore);

    await mock.simulateMessage({ type: 'acceptItem', providerId: 'github', externalId: '99' });
    await mock.simulateMessage({ type: 'dismissItem', providerId: 'github', externalId: '99' });

    await vi.waitFor(() => {
      expect(workGraph.createItem).toHaveBeenCalledWith(
        { title: 'Incoming item', description: 'Desc' },
        { providerId: 'github', externalId: '99', url: 'https://example.com/99', group: 'repo' },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', '99', 'accepted');
      expect(stateStore.setState).toHaveBeenCalledWith('github', '99', 'dismissed');
    });
  });

  it('reuses existing panels for the same item', () => {
    const item = makeItem({ id: 'reuse-1', title: 'Reusable' });
    const mock = createMockWebviewPanel();
    const context = createMockContext();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);
    WorkItemEditorPanel.setDependencies(createMockActionRegistry() as any, createMockStateStore() as any);

    WorkItemEditorPanel.open(context, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);
    WorkItemEditorPanel.open(context, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item);

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mock.panel.reveal).toHaveBeenCalledTimes(1);
  });
});

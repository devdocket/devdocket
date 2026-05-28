import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ViewColumn, window } from 'vscode';
import { PanelManager, WorkItemEditorPanel, type WorkItemEditorPanelDependencies } from '../views/workItemEditorPanel';
import { WorkItem, WorkItemState } from '../models/workItem';
import type { ActivityLogEntry, ActivityType } from '../models/activityLog';

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

function appendActivityLogEntry(item: WorkItem, type: ActivityType, detail?: string): WorkItem {
  const now = Date.now();
  const entry: ActivityLogEntry = { timestamp: now, type, ...(detail !== undefined ? { detail } : {}) };
  return { ...item, activityLog: [...(item.activityLog ?? []), entry], updatedAt: now };
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

  const applyPatch = async (id: string, patch: Record<string, unknown>) => {
    const current = items.get(id);
    if (!current) {
      throw new Error(`Missing item ${id}`);
    }
    items.set(id, { ...current, ...patch, updatedAt: Date.now() });
    changeEmitter.fire();
  };

  return {
    getAll: vi.fn(() => Array.from(items.values())),
    getRelatedItemsVersion: vi.fn(() => 1),
    getItem: vi.fn((id: string) => items.get(id)),
    updateItem: vi.fn(applyPatch),
    updateItemDuringShutdown: vi.fn(applyPatch),
    transitionState: vi.fn(async (id: string, targetState: WorkItemState) => {
      const current = items.get(id);
      if (!current) {
        throw new Error(`Missing item ${id}`);
      }
      items.set(id, appendActivityLogEntry(
        { ...current, state: targetState },
        'state-changed',
        `${current.state} → ${targetState}`,
      ));
      changeEmitter.fire();
    }),
    addActivity: vi.fn(async (id: string, type: ActivityType, detail?: string) => {
      const current = items.get(id);
      if (!current) {
        throw new Error(`Missing item ${id}`);
      }
      items.set(id, appendActivityLogEntry(current, type, detail));
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
  const discoveredEmitter = new EventEmitter<string | undefined>();
  const registerEmitter = new EventEmitter<void>();

  const registry: any = {
    getProviderItems: vi.fn((providerId: string) => discoveredByProvider[providerId] ?? []),
    getAllProviderItems: vi.fn(() => new Map(Object.entries(discoveredByProvider))),
    getProvider: vi.fn((providerId: string) => providerId ? { id: providerId, label: providerId } : undefined),
    getProviderLabel: vi.fn((providerId: string) => providerId === 'github' ? 'GitHub' : providerId),
    onDidChangeProviderItems: discoveredEmitter.event,
    onDidRegisterProvider: registerEmitter.event,
    _fireProviderItemsChange: (providerId?: string) => discoveredEmitter.fire(providerId),
    _fireRegisterProvider: () => registerEmitter.fire(),
  };
  registry.findProviderItem = vi.fn((providerId: string, externalId: string) =>
    registry.getProviderItems(providerId).find((item: any) => item.externalId === externalId));
  return registry;
}

function createMockActionRegistry() {
  const changeEmitter = new EventEmitter<void>();
  return {
    hasActionsFor: vi.fn(() => false),
    getSurfaceActionsFor: vi.fn(() => []),
    onDidChangeRegistrations: vi.fn((listener: () => void) => changeEmitter.event(listener)),
    _fireChange: () => changeEmitter.fire(),
  };
}

function createMockStateStore() {
  return {
    setState: vi.fn(async () => undefined),
  };
}

function makeWatchedRun(overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  return {
    identifier: {
      providerId: 'github-actions',
      runId: 'run-1',
      displayName: 'build',
      repo: 'owner/repo',
      url: 'https://example.com/run/1',
    },
    status: {
      overallState: 'running',
      conclusion: undefined,
      jobs: [],
    },
    watchedAt: now,
    lastPolledAt: now,
    dismissed: false,
    parentPRKey: 'pr:github-pr-watcher:owner/repo:42',
    ...overrides,
  };
}

function makeWatchedPR(overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  return {
    identifier: {
      providerId: 'github-pr-watcher',
      prId: '42',
      displayName: 'PR #42',
      repo: 'owner/repo',
      url: 'https://example.com/pull/42',
    },
    prState: 'open',
    childRunKeys: ['github-actions:owner/repo:run-1'],
    watchedAt: now,
    lastPolledAt: now,
    dismissed: false,
    ...overrides,
  };
}

function createMockWatcherService(initialWatch?: any, initialRuns: any[] = []) {
  const prEmitter = new EventEmitter<void>();
  const runEmitter = new EventEmitter<any[]>();
  let watch = initialWatch;
  let runs = [...initialRuns];

  return {
    findPRWatchByExternalId: vi.fn((repo: string, prId: string) => (
      watch && !watch.dismissed && watch.identifier.repo === repo && watch.identifier.prId === prId ? watch : undefined
    )),
    getPRWatchKey: vi.fn((identifier: any) => `pr:${identifier.providerId}:${identifier.repo}:${identifier.prId}`),
    getChildRuns: vi.fn(() => runs.filter(run => !run.dismissed)),
    onDidChangePRWatches: prEmitter.event,
    onDidChangeWatchedRuns: runEmitter.event,
    _setWatch: (nextWatch: any) => { watch = nextWatch; },
    _setRuns: (nextRuns: any[]) => { runs = [...nextRuns]; },
    _firePRWatchesChange: () => prEmitter.fire(),
    _fireWatchedRunsChange: (changedRuns = runs) => runEmitter.fire(changedRuns),
  };
}

function getBootstrapItem(html: string) {
  const match = html.match(/window\.__DEVDOCKET_EDITOR_BOOTSTRAP__ = (.*?);\s*<\/script>/s);
  if (!match) {
    throw new Error('Missing editor bootstrap payload');
  }
  return JSON.parse(match[1]);
}

function getLastEditorUpdate(mock: ReturnType<typeof createMockWebviewPanel>) {
  const messages = vi.mocked(mock.panel.webview.postMessage).mock.calls.map(call => call[0] as any);
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === 'updateEditorItem') {
      return messages[index];
    }
  }
  return undefined;
}

function createMockContext() {
  return {
    extensionUri: vscode.Uri.file('C:\\repos\\devdocket-mission-control-454\\packages\\core'),
    subscriptions: [] as Array<{ dispose(): void }>,
  } as unknown as vscode.ExtensionContext;
}

function createEditorDependencies(
  actionRegistry = createMockActionRegistry(),
  stateStore = createMockStateStore(),
  watcherService?: ReturnType<typeof createMockWatcherService>,
  panelManager = new PanelManager(),
): WorkItemEditorPanelDependencies {
  return {
    panelManager,
    actionRegistry: actionRegistry as any,
    stateStore: stateStore as any,
    watcherService: watcherService as any,
  };
}

function openPanel(
  item: WorkItem,
  workGraph = createMockWorkGraph(item),
  providerRegistry = createMockProviderRegistry(),
  actionRegistry = createMockActionRegistry(),
  stateStore = createMockStateStore(),
  watcherService?: ReturnType<typeof createMockWatcherService>,
  panelManager = new PanelManager(),
) {
  const mock = createMockWebviewPanel();
  const context = createMockContext();
  const dependencies = createEditorDependencies(actionRegistry, stateStore, watcherService, panelManager);
  vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);
  WorkItemEditorPanel.open(context, workGraph as any, providerRegistry as any, item, dependencies, item.providerId ? 'GitHub' : undefined);
  return { mock, context, workGraph, providerRegistry, actionRegistry, stateStore, watcherService, panelManager, dependencies };
}

describe('WorkItemEditorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('does not expose mutable static dependency state', () => {
    const keys = Reflect.ownKeys(WorkItemEditorPanel);
    for (const key of ['panelManager', 'actionRegistry', 'stateStore', 'watcherService', 'setPanelManager', 'setDependencies']) {
      expect(keys).not.toContain(key);
    }
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

  it('posts updateEditorItem when activity is appended to the open item', async () => {
    const item = makeItem({ id: 'item-1', activityLog: [] });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);
    vi.mocked(mock.panel.webview.postMessage).mockClear();

    await workGraph.addActivity(item.id, 'action-executed', 'branch created');

    expect(getLastEditorUpdate(mock)).toEqual(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.objectContaining({
        activityLog: [expect.objectContaining({
          type: 'action-executed',
          detail: 'branch created',
        })],
      }),
    }));
  });

  it('does not update when activity is appended to a different item', async () => {
    const item = makeItem({ id: 'item-1', activityLog: [] });
    const other = makeItem({ id: 'item-2', title: 'Other item', activityLog: [] });
    const workGraph = createMockWorkGraph(item, { 'manual::item-2': other });
    const { mock } = openPanel(item, workGraph);
    vi.mocked(mock.panel.webview.postMessage).mockClear();

    await workGraph.addActivity(other.id, 'action-executed', 'branch created elsewhere');

    expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('posts one consistent update for state transition activity', async () => {
    const item = makeItem({ id: 'item-1', state: WorkItemState.New, activityLog: [] });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);
    vi.mocked(mock.panel.webview.postMessage).mockClear();

    await workGraph.transitionState(item.id, WorkItemState.InProgress);

    expect(mock.panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(getLastEditorUpdate(mock)).toEqual(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.objectContaining({
        state: WorkItemState.InProgress,
        activityLog: [expect.objectContaining({
          type: 'state-changed',
          detail: `${WorkItemState.New} → ${WorkItemState.InProgress}`,
        })],
      }),
    }));
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

    providerRegistry.getProviderItems.mockImplementation((providerId: string) => {
      if (providerId === 'github-my-prs') {
        return [{ externalId: 'owner/repo#42', title: 'Primary', state: 'closed', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }];
      }
      return [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue' }];
    });
    providerRegistry.getAllProviderItems.mockImplementation(() => new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#42', title: 'Primary', state: 'closed', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }]],
      ['github-issues', [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue' }]],
    ]));

    providerRegistry._fireProviderItemsChange();

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.objectContaining({
        description: '<h2>Updated description</h2>\n',
        hasActions: true,
        validTransitions: expect.arrayContaining(['InProgress', 'Done', 'Archived']),
        relatedItems: [expect.objectContaining({ targetItemId: 'peer-1', label: 'Closes Peer' })],
      }),
    }));
  });

  it('does not update when a provider-items event is for a different provider', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open' }],
      'github-issues': [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active' }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();

    providerRegistry._fireProviderItemsChange('github-issues');

    expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('short-circuits related snapshot rebuilds when the provider item has no related refs', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open' }],
      'github-issues': [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue' }],
    });
    const { panelManager } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    const editor = panelManager.openPanels.get(item.id) as any;
    providerRegistry.getAllProviderItems.mockClear();

    const snapshots = editor.buildRelatedProviderItemSnapshots(item) as Map<string, string>;

    expect(snapshots.size).toBe(0);
    expect(providerRegistry.getAllProviderItems).not.toHaveBeenCalled();
  });

  it('checks only the changed provider snapshot for provider-specific unchanged events', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }],
      'github-issues': [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue', version: '1' }],
      'github-mentions': [{ externalId: 'owner/repo#100', title: 'Other', state: 'active', itemType: 'issue', version: '1' }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerRegistry.getAllProviderItems.mockClear();
    providerRegistry.getProviderItems.mockClear();

    providerRegistry._fireProviderItemsChange('github-issues');

    expect(providerRegistry.getProviderItems.mock.calls.map(call => call[0])).toEqual(['github-issues']);
    expect(providerRegistry.getAllProviderItems).not.toHaveBeenCalled();
    expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('updates when a related provider item updatedAt token changes', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerItems = {
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }],
      'github-issues': [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue', updatedAt: '2026-05-01T00:00:00Z' }],
    };
    const providerRegistry = createMockProviderRegistry(providerItems);
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerItems['github-issues'] = [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue', updatedAt: '2026-05-02T00:00:00Z' }];

    providerRegistry._fireProviderItemsChange('github-issues');

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
    }));
  });

  it('updates when a related provider item version changes', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }],
      'github-issues': [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', version: '1' }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerRegistry.getProviderItems.mockImplementation((providerId: string) => {
      if (providerId === 'github-issues') {
        return [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', version: '2' }];
      }
      return [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }];
    });
    providerRegistry.getAllProviderItems.mockReturnValue(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] }]],
      ['github-issues', [{ externalId: 'owner/repo#99', title: 'Peer', state: 'active', version: '2' }]],
    ]));

    providerRegistry._fireProviderItemsChange('github-issues');

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
    }));
  });

  it('updates when a related item in the same provider changes version', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const primary = { externalId: 'owner/repo#42', title: 'Primary', state: 'open', relatedItems: [{ externalId: 'owner/repo#99', itemType: 'issue', relation: 'closes' }] };
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [primary, { externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue', version: '1' }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerRegistry.getProviderItems.mockReturnValue([
      primary,
      { externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue', version: '2' },
    ]);
    providerRegistry.getAllProviderItems.mockReturnValue(new Map([
      ['github-my-prs', [primary, { externalId: 'owner/repo#99', title: 'Peer', state: 'active', itemType: 'issue', version: '2' }]],
    ]));

    providerRegistry._fireProviderItemsChange('github-my-prs');

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
    }));
  });

  it('updates when its provider item changes', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open' }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerRegistry.getProviderItems.mockReturnValue([
      { externalId: 'owner/repo#42', title: 'Primary', state: 'closed' },
    ]);
    providerRegistry.getAllProviderItems.mockReturnValue(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#42', title: 'Primary', state: 'closed' }]],
    ]));

    providerRegistry._fireProviderItemsChange('github-my-prs');

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
    }));
  });

  it('updates when provider item function-valued capabilities change', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{
        externalId: 'owner/repo#42',
        title: 'Primary',
        state: 'open',
        capabilities: { gitWork: () => Promise.resolve({ kind: 'pr' }) },
      }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerRegistry.getProviderItems.mockReturnValue([
      { externalId: 'owner/repo#42', title: 'Primary', state: 'open', capabilities: {} },
    ]);

    providerRegistry._fireProviderItemsChange('github-my-prs');

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateEditorItem',
    }));
  });

  it('does not update when its provider item is unchanged', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42' });
    const providerRegistry = createMockProviderRegistry({
      'github-my-prs': [{ externalId: 'owner/repo#42', title: 'Primary', state: 'open' }],
    });
    const { mock } = openPanel(item, createMockWorkGraph(item), providerRegistry);
    vi.mocked(mock.panel.webview.postMessage).mockClear();
    providerRegistry.getProviderItems.mockReturnValue([
      { state: 'open', title: 'Primary', externalId: 'owner/repo#42' },
    ]);

    providerRegistry._fireProviderItemsChange('github-my-prs');

    expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('includes CI watch data for watched PRs across provider IDs', () => {
    const item = makeItem({
      title: 'Watched PR',
      providerId: 'github-my-prs',
      externalId: 'owner/repo#42',
      itemType: 'pr',
    });
    const watch = makeWatchedPR();
    const runs = [
      makeWatchedRun({ identifier: { ...makeWatchedRun().identifier, runId: 'run-1', displayName: 'build' } }),
      makeWatchedRun({
        identifier: { ...makeWatchedRun().identifier, runId: 'run-2', displayName: 'test' },
        status: { overallState: 'completed', conclusion: 'success', jobs: [] },
      }),
      makeWatchedRun({
        identifier: { ...makeWatchedRun().identifier, runId: 'run-3', displayName: 'deploy' },
        status: { overallState: 'completed', conclusion: 'failure', jobs: [] },
      }),
    ];
    const watcherService = createMockWatcherService(watch, runs);

    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);
    const bootstrap = getBootstrapItem(mock.panel.webview.html);

    expect(watcherService.findPRWatchByExternalId).toHaveBeenCalledWith('owner/repo', '42');
    expect(bootstrap.ciWatch).toEqual({
      state: 'open',
      runs: [
        { id: 'github-actions:owner/repo:run-1', name: 'build', state: 'in_progress' },
        { id: 'github-actions:owner/repo:run-2', name: 'test', state: 'completed', conclusion: 'success' },
        { id: 'github-actions:owner/repo:run-3', name: 'deploy', state: 'completed', conclusion: 'failure' },
      ],
      totalActive: 1,
      totalFailing: 1,
    });
  });

  it('excludes partial-success child runs from CI watch failing totals', () => {
    const item = makeItem({
      title: 'Watched PR',
      providerId: 'github-my-prs',
      externalId: 'owner/repo#42',
      itemType: 'pr',
    });
    const watch = makeWatchedPR();
    const runs = [
      makeWatchedRun({
        identifier: { ...makeWatchedRun().identifier, runId: 'run-partial', displayName: 'publish' },
        status: { overallState: 'completed', conclusion: 'partial_success', jobs: [] },
      }),
    ];
    const watcherService = createMockWatcherService(watch, runs);

    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);
    const bootstrap = getBootstrapItem(mock.panel.webview.html);

    expect(bootstrap.ciWatch).toEqual(expect.objectContaining({
      runs: [{ id: 'github-actions:owner/repo:run-partial', name: 'publish', state: 'completed', conclusion: 'partial_success' }],
      totalActive: 0,
      totalFailing: 0,
    }));
  });

  it('omits CI watch data when the PR is not watched', () => {
    const item = makeItem({
      title: 'Unwatched PR',
      providerId: 'github-my-prs',
      externalId: 'owner/repo#42',
      itemType: 'pr',
    });
    const watcherService = createMockWatcherService(undefined, []);

    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);
    const bootstrap = getBootstrapItem(mock.panel.webview.html);

    expect(bootstrap.ciWatch).toBeUndefined();
    expect(mock.panel.webview.html).not.toContain('ciWatch');
  });

  it('removes CI watch data when the PR watch is dismissed while open', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42', itemType: 'pr' });
    const watch = makeWatchedPR();
    const watcherService = createMockWatcherService(watch, [makeWatchedRun()]);
    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);

    watcherService._setWatch({ ...watch, dismissed: true });
    watcherService._firePRWatchesChange();

    expect(getLastEditorUpdate(mock)).toEqual(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.not.objectContaining({ ciWatch: expect.anything() }),
    }));
  });

  it('updates CI watch data when a child run changes state while open', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42', itemType: 'pr' });
    const watch = makeWatchedPR();
    const watcherService = createMockWatcherService(watch, [makeWatchedRun()]);
    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);

    watcherService._setRuns([
      makeWatchedRun({ status: { overallState: 'completed', conclusion: 'failure', jobs: [] } }),
    ]);
    watcherService._fireWatchedRunsChange();

    expect(getLastEditorUpdate(mock)).toEqual(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.objectContaining({
        ciWatch: expect.objectContaining({
          runs: [{ id: 'github-actions:owner/repo:run-1', name: 'build', state: 'completed', conclusion: 'failure' }],
          totalActive: 0,
          totalFailing: 1,
        }),
      }),
    }));
  });

  it('refreshes CI watch data when the last child run disappears while the PR remains watched', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42', itemType: 'pr' });
    const watch = makeWatchedPR();
    const watcherService = createMockWatcherService(watch, [makeWatchedRun()]);
    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);

    watcherService._setRuns([]);
    watcherService._fireWatchedRunsChange();

    expect(getLastEditorUpdate(mock)).toEqual(expect.objectContaining({
      type: 'updateEditorItem',
      item: expect.objectContaining({
        ciWatch: expect.objectContaining({
          runs: [],
          totalActive: 0,
          totalFailing: 0,
        }),
      }),
    }));
  });

  it('ignores PR watch changes when the current PR watch state is unchanged', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42', itemType: 'pr' });
    const watcherService = createMockWatcherService(makeWatchedPR(), [makeWatchedRun()]);
    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);
    vi.mocked(mock.panel.webview.postMessage).mockClear();

    watcherService._firePRWatchesChange();

    expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('ignores watched run changes that do not affect the current PR watch', () => {
    const item = makeItem({ providerId: 'github-my-prs', externalId: 'owner/repo#42', itemType: 'pr' });
    const watcherService = createMockWatcherService(makeWatchedPR(), [makeWatchedRun()]);
    const { mock } = openPanel(item, createMockWorkGraph(item), createMockProviderRegistry(), createMockActionRegistry(), createMockStateStore(), watcherService);
    vi.mocked(mock.panel.webview.postMessage).mockClear();

    watcherService._fireWatchedRunsChange([
      makeWatchedRun({
        identifier: {
          providerId: 'github-actions',
          runId: 'run-99',
          displayName: 'unrelated',
          repo: 'owner/other-repo',
          url: 'https://example.com/run/99',
        },
        parentPRKey: 'pr:github-pr-watcher:owner/other-repo:99',
      }),
    ]);

    expect(mock.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('opens the CI Watches panel from editor messages', async () => {
    const item = makeItem();
    const { mock } = openPanel(item);

    await mock.simulateMessage({ type: 'openWatches' });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.showWatchesQuickPick');
  });

  it('debounces autosave, saves manual fields, and acknowledges the request', async () => {
    vi.useFakeTimers({ now: 1234 });
    const item = makeItem({ title: 'Original' });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    mock.simulateMessage({
      type: 'autosave',
      requestId: 'save-1',
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
    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'autosaveAck',
      requestId: 'save-1',
      savedAt: expect.any(Number),
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
      expect(workGraph.updateItemDuringShutdown).toHaveBeenCalledWith('item-1', {
        title: 'Updated before close',
        notes: 'Draft notes',
      });
    });
    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('saves manual notes without requiring title or URL fields', async () => {
    vi.useFakeTimers();
    const item = makeItem({ title: 'Original' });
    const workGraph = createMockWorkGraph(item);
    const { mock } = openPanel(item, workGraph);

    mock.simulateMessage({
      type: 'autosave',
      data: { notes: ' Draft note ' },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', { notes: 'Draft note' });
  });

  it('posts autosaveError when saving fails', async () => {
    vi.useFakeTimers();
    const item = makeItem({ title: 'Original' });
    const workGraph = createMockWorkGraph(item);
    workGraph.updateItem.mockRejectedValueOnce(new Error('disk full'));
    const { mock } = openPanel(item, workGraph);

    mock.simulateMessage({
      type: 'autosave',
      requestId: 'save-error',
      data: { notes: ' Draft note ' },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(mock.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'autosaveError',
      requestId: 'save-error',
      message: 'disk full',
    });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to save work item: disk full');
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

  it('opens a URL exactly once when the host receives a single openUrl message', async () => {
    const item = makeItem({ url: 'https://example.com/item/1' });
    const { mock } = openPanel(item);

    await mock.simulateMessage({ type: 'openUrl', url: 'https://example.com/item/1' });

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://example.com/item/1');
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
    const dependencies = createEditorDependencies(undefined, undefined, undefined, new PanelManager());

    WorkItemEditorPanel.open(context, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item, dependencies);
    WorkItemEditorPanel.open(context, createMockWorkGraph(item) as any, createMockProviderRegistry() as any, item, dependencies);

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mock.panel.reveal).toHaveBeenCalledTimes(1);
  });

  it('scopes panel reuse to the injected panel manager', () => {
    const item = makeItem({ id: 'reuse-activation-1', title: 'Reusable per activation' });
    const firstMock = createMockWebviewPanel();
    const secondMock = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel)
      .mockReturnValueOnce(firstMock.panel as any)
      .mockReturnValueOnce(secondMock.panel as any);

    WorkItemEditorPanel.open(
      createMockContext(),
      createMockWorkGraph(item) as any,
      createMockProviderRegistry() as any,
      item,
      createEditorDependencies(undefined, undefined, undefined, new PanelManager()),
    );
    WorkItemEditorPanel.open(
      createMockContext(),
      createMockWorkGraph(item) as any,
      createMockProviderRegistry() as any,
      item,
      createEditorDependencies(undefined, undefined, undefined, new PanelManager()),
    );

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(firstMock.panel.reveal).not.toHaveBeenCalled();
    expect(secondMock.panel.reveal).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { QueueTreeProvider } from '../views/queueTreeProvider';
import { FocusTreeProvider } from '../views/focusTreeProvider';
import { HistoryTreeProvider } from '../views/historyTreeProvider';
import { InboxTreeProvider } from '../views/inboxTreeProvider';
import { SourcesTreeProvider } from '../views/sourcesTreeProvider';
import { isProviderGroupNode } from '../views/viewLayout';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createMockProviderRegistry(discoveredItems: Map<string, any[]> = new Map()) {
  return {
    getProviderLabel: vi.fn((id: string) => id),
    onDidRegisterProvider: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeDiscoveredItems: vi.fn(() => ({ dispose: vi.fn() })),
    getAllDiscoveredItems: vi.fn(() => discoveredItems),
    getDiscoveredItems: vi.fn((providerId: string) => discoveredItems.get(providerId) ?? []),
    loading: false,
  };
}

function createMockStateStore() {
  const states = new Map<string, string>();
  return {
    getState: vi.fn((_providerId: string, _externalId: string) => undefined as string | undefined),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    load: vi.fn(async () => {}),
    setState: vi.fn(),
    setStates: vi.fn(),
    dispose: vi.fn(),
  };
}

function createMockReadStateStore() {
  const keys = new Set<string>();
  return {
    has: vi.fn((key: string) => keys.has(key)),
    add: vi.fn(async (key: string) => { keys.add(key); return true; }),
    addMany: vi.fn(async (newKeys: string[]) => { for (const k of newKeys) { keys.add(k); } return newKeys; }),
    keys: vi.fn(() => keys.keys()),
    deleteMany: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
  };
}

// ─── WorkItemViewProvider (via QueueTreeProvider) ────────────────────────

describe('WorkItemViewProvider filter', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let provider: QueueTreeProvider;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    provider = new QueueTreeProvider(graph);
  });

  it('defaults to empty filterText', () => {
    expect(provider.filterText).toBe('');
  });

  it('fires onDidChangeTreeData when filterText changes', () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.filterText = 'bug';
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire when setting same filterText', () => {
    provider.filterText = 'bug';
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.filterText = 'bug';
    expect(listener).not.toHaveBeenCalled();
  });

  it('normalizes filterText (trims and lowercases)', () => {
    provider.filterText = '  BUG  ';
    expect(provider.filterText).toBe('bug');
  });

  it('filters items by title', async () => {
    await graph.createItem({ title: 'Fix login bug' });
    await graph.createItem({ title: 'Add dashboard' });
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Fix login bug');
  });

  it('filters items by notes', async () => {
    await graph.createItem({ title: 'Task A', notes: 'Related to authentication' });
    await graph.createItem({ title: 'Task B', notes: 'UI improvement' });
    provider.filterText = 'authentication';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Task A');
  });

  it('filters items by providerId', async () => {
    await graph.createItem({ title: 'Issue 1' }, { providerId: 'github', externalId: 'ext-1' });
    await graph.createItem({ title: 'Issue 2' }, { providerId: 'jira', externalId: 'ext-2' });
    provider.filterText = 'github';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Issue 1');
  });

  it('filters items by group', async () => {
    await graph.createItem({ title: 'Bug fix' }, { providerId: 'github', externalId: 'ext-1', group: 'bugs' });
    await graph.createItem({ title: 'New feature' }, { providerId: 'github', externalId: 'ext-2', group: 'features' });
    provider.filterText = 'bugs';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Bug fix');
  });

  it('is case-insensitive', async () => {
    await graph.createItem({ title: 'Fix LOGIN Bug' });
    await graph.createItem({ title: 'Add dashboard' });
    provider.filterText = 'login';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Fix LOGIN Bug');
  });

  it('empty filterText shows all items', async () => {
    await graph.createItem({ title: 'A' });
    await graph.createItem({ title: 'B' });
    provider.filterText = 'xyz';
    expect(provider.getChildren()).toHaveLength(0);
    provider.filterText = '';
    expect(provider.getChildren()).toHaveLength(2);
  });

  it('filter works in tree layout mode', async () => {
    await graph.createItem({ title: 'Bug fix' }, { providerId: 'github', externalId: 'ext-1' });
    await graph.createItem({ title: 'Feature' }, { providerId: 'github', externalId: 'ext-2' });
    await graph.createItem({ title: 'Jira task' }, { providerId: 'jira', externalId: 'ext-3' });

    const mockRegistry = {
      getProviderLabel: vi.fn((id: string) => id),
      onDidRegisterProvider: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const treeProvider = new QueueTreeProvider(graph, mockRegistry as any);
    treeProvider.layout = 'tree';
    treeProvider.filterText = 'bug';

    // Only github group should show (it has matching item)
    const groups = treeProvider.getChildren();
    expect(groups).toHaveLength(1);
    expect(isProviderGroupNode(groups[0])).toBe(true);
    expect((groups[0] as any).label).toBe('github');

    // Expanding github group should show only the matching item
    const items = treeProvider.getChildren(groups[0]);
    expect(items).toHaveLength(1);
    expect((items[0] as any).title).toBe('Bug fix');
  });

  it('clearing filter restores all items', async () => {
    await graph.createItem({ title: 'A' });
    await graph.createItem({ title: 'B' });
    await graph.createItem({ title: 'C' });
    provider.filterText = 'A';
    expect(provider.getChildren()).toHaveLength(1);
    provider.filterText = '';
    expect(provider.getChildren()).toHaveLength(3);
  });
});

// ─── FocusTreeProvider filter ────────────────────────────────────────────

describe('FocusTreeProvider filter', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let provider: FocusTreeProvider;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    provider = new FocusTreeProvider(graph);
  });

  it('filters focus items by title', async () => {
    const item1 = await graph.createItem({ title: 'Debug login' });
    const item2 = await graph.createItem({ title: 'Write tests' });
    await graph.transitionState(item1.id, WorkItemState.InProgress);
    await graph.transitionState(item2.id, WorkItemState.InProgress);
    provider.filterText = 'debug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Debug login');
  });
});

// ─── HistoryTreeProvider filter ──────────────────────────────────────────

describe('HistoryTreeProvider filter', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let provider: HistoryTreeProvider;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    provider = new HistoryTreeProvider(graph);
  });

  it('filters history items by title', async () => {
    const item1 = await graph.createItem({ title: 'Completed task' });
    const item2 = await graph.createItem({ title: 'Another done' });
    await graph.transitionState(item1.id, WorkItemState.InProgress);
    await graph.transitionState(item1.id, WorkItemState.Done);
    await graph.transitionState(item2.id, WorkItemState.InProgress);
    await graph.transitionState(item2.id, WorkItemState.Done);
    provider.filterText = 'completed';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Completed task');
  });
});

// ─── InboxTreeProvider filter ────────────────────────────────────────────

describe('InboxTreeProvider filter', () => {
  let provider: InboxTreeProvider;
  let providerRegistry: ReturnType<typeof createMockProviderRegistry>;
  let stateStore: ReturnType<typeof createMockStateStore>;
  let readStateStore: ReturnType<typeof createMockReadStateStore>;

  function setDiscoveredItems(items: Array<{ providerId: string; externalId: string; title: string; description?: string; reason?: string; group?: string }>) {
    const map = new Map<string, any[]>();
    for (const item of items) {
      const list = map.get(item.providerId) ?? [];
      list.push(item);
      map.set(item.providerId, list);
    }
    providerRegistry.getAllDiscoveredItems.mockReturnValue(map);
    providerRegistry.getDiscoveredItems.mockImplementation((id: string) => map.get(id) ?? []);
  }

  beforeEach(() => {
    providerRegistry = createMockProviderRegistry();
    stateStore = createMockStateStore();
    readStateStore = createMockReadStateStore();
    provider = new InboxTreeProvider(providerRegistry as any, stateStore as any, readStateStore as any);
  });

  it('defaults to empty filterText', () => {
    expect(provider.filterText).toBe('');
  });

  it('fires onDidChangeTreeData when filterText changes', () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.filterText = 'bug';
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('filters flat-mode items by title', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix bug' },
      { providerId: 'gh', externalId: '2', title: 'Add feature' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Fix bug');
  });

  it('filters items by description', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Task A', description: 'Authentication issue' },
      { providerId: 'gh', externalId: '2', title: 'Task B', description: 'UI tweak' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'authentication';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Task A');
  });

  it('filters items by reason', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Task A', reason: 'assigned' },
      { providerId: 'gh', externalId: '2', title: 'Task B', reason: 'mentioned' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'assigned';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Task A');
  });

  it('is case-insensitive', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix BUG' },
      { providerId: 'gh', externalId: '2', title: 'Add feature' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
  });

  it('hides providers with no matching children in tree mode', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix bug' },
      { providerId: 'jira', externalId: '2', title: 'Add feature' },
    ]);
    provider.layout = 'tree';
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).providerId).toBe('gh');
  });

  it('empty filterText shows all items', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'A' },
      { providerId: 'gh', externalId: '2', title: 'B' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'xyz';
    expect(provider.getChildren()).toHaveLength(0);
    provider.filterText = '';
    expect(provider.getChildren()).toHaveLength(2);
  });
});

// ─── SourcesTreeProvider filter ──────────────────────────────────────────

describe('SourcesTreeProvider filter', () => {
  let provider: SourcesTreeProvider;
  let providerRegistry: ReturnType<typeof createMockProviderRegistry>;
  let stateStore: ReturnType<typeof createMockStateStore>;

  function setDiscoveredItems(items: Array<{ providerId: string; externalId: string; title: string; description?: string; group?: string }>) {
    const map = new Map<string, any[]>();
    for (const item of items) {
      const list = map.get(item.providerId) ?? [];
      list.push(item);
      map.set(item.providerId, list);
    }
    providerRegistry.getAllDiscoveredItems.mockReturnValue(map);
    providerRegistry.getDiscoveredItems.mockImplementation((id: string) => map.get(id) ?? []);
  }

  beforeEach(() => {
    providerRegistry = createMockProviderRegistry();
    stateStore = createMockStateStore();
    provider = new SourcesTreeProvider(providerRegistry as any, stateStore as any);
  });

  it('defaults to empty filterText', () => {
    expect(provider.filterText).toBe('');
  });

  it('fires onDidChangeTreeData when filterText changes', () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.filterText = 'bug';
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('filters flat-mode items by title', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix bug' },
      { providerId: 'gh', externalId: '2', title: 'Add feature' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Fix bug');
  });

  it('filters items by description', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Task A', description: 'Authentication issue' },
      { providerId: 'gh', externalId: '2', title: 'Task B', description: 'UI tweak' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'authentication';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).title).toBe('Task A');
  });

  it('is case-insensitive', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix BUG' },
      { providerId: 'gh', externalId: '2', title: 'Add feature' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
  });

  it('hides providers with no matching children in tree mode', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix bug' },
      { providerId: 'jira', externalId: '2', title: 'Add feature' },
    ]);
    provider.layout = 'tree';
    provider.filterText = 'bug';
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect((children[0] as any).providerId).toBe('gh');
  });

  it('filters group children', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'Fix bug', group: 'bugs' },
      { providerId: 'gh', externalId: '2', title: 'Add feature', group: 'bugs' },
    ]);
    provider.layout = 'tree';
    provider.filterText = 'fix';
    // Get provider node
    const providers = provider.getChildren();
    expect(providers).toHaveLength(1);
    // Get group node
    const groups = provider.getChildren(providers[0]);
    expect(groups).toHaveLength(1);
    // Get items under group
    const items = provider.getChildren(groups[0]);
    expect(items).toHaveLength(1);
    expect((items[0] as any).title).toBe('Fix bug');
  });

  it('empty filterText shows all items', () => {
    setDiscoveredItems([
      { providerId: 'gh', externalId: '1', title: 'A' },
      { providerId: 'gh', externalId: '2', title: 'B' },
    ]);
    provider.layout = 'flat';
    provider.filterText = 'xyz';
    expect(provider.getChildren()).toHaveLength(0);
    provider.filterText = '';
    expect(provider.getChildren()).toHaveLength(2);
  });
});

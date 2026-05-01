import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, MockMemento } from 'vscode';
import { WorkGraph } from '../services/workGraph';
import { ItemLinkStore } from '../storage/itemLinkStore';
import { LinkingService } from '../services/linkingService';
import type { ITaskStore } from '../storage/taskStore';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createMockProviderRegistry() {
  const refreshEmitter = new EventEmitter<string>();
  const discoveredItems = new Map<string, any[]>();
  return {
    onDidRefreshProvider: refreshEmitter.event,
    getAllDiscoveredItems: vi.fn(() => discoveredItems),
    setDiscovered(providerId: string, items: any[]) {
      discoveredItems.set(providerId, items);
    },
    fireRefresh(providerId: string) {
      refreshEmitter.fire(providerId);
    },
    dispose() {
      refreshEmitter.dispose();
    },
  };
}

describe('LinkingService', () => {
  let workGraph: WorkGraph;
  let linkStore: ItemLinkStore;
  let providerRegistry: ReturnType<typeof createMockProviderRegistry>;
  let linkingService: LinkingService;

  beforeEach(async () => {
    workGraph = new WorkGraph(createMockStore());
    await workGraph.load();
    linkStore = new ItemLinkStore(new MockMemento());
    await linkStore.load();
    providerRegistry = createMockProviderRegistry();
    linkingService = new LinkingService(workGraph, providerRegistry as any, linkStore);
  });

  afterEach(() => {
    linkingService.dispose();
    providerRegistry.dispose();
    linkStore.dispose();
    workGraph.dispose();
  });

  it('creates provider-origin links when both work items exist', async () => {
    const issue = await workGraph.createItem({ title: 'Issue' }, { providerId: 'github', externalId: 'org/repo#1' });
    const pr = await workGraph.createItem({ title: 'PR' }, { providerId: 'github-my-prs', externalId: 'org/repo#101' });
    providerRegistry.setDiscovered('github-my-prs', [{
      externalId: 'org/repo#101',
      title: '#101: Fix issue',
      relatedItems: [{ externalId: 'org/repo#1', relation: 'closes' }],
    }]);

    providerRegistry.fireRefresh('github-my-prs');

    await vi.waitFor(async () => {
      expect(await linkStore.loadAll()).toHaveLength(1);
    });
    const [link] = await linkStore.loadAll();
    expect(link.relation).toBe('closes');
    expect(link.origin).toBe('provider');
    expect(workGraph.getItem(issue.id)?.activityLog?.at(-1)?.type).toBe('item-linked');
    expect(workGraph.getItem(pr.id)?.activityLog?.at(-1)?.type).toBe('item-linked');
  });

  it('removes stale provider-origin links when the relation disappears', async () => {
    const issue = await workGraph.createItem({ title: 'Issue' }, { providerId: 'github', externalId: 'org/repo#1' });
    const pr = await workGraph.createItem({ title: 'PR' }, { providerId: 'github-my-prs', externalId: 'org/repo#101' });
    providerRegistry.setDiscovered('github-my-prs', [{
      externalId: 'org/repo#101',
      title: '#101: Fix issue',
      relatedItems: [{ externalId: 'org/repo#1', relation: 'closes' }],
    }]);
    providerRegistry.fireRefresh('github-my-prs');
    await vi.waitFor(async () => {
      expect(await linkStore.loadAll()).toHaveLength(1);
    });

    providerRegistry.setDiscovered('github-my-prs', [{ externalId: 'org/repo#101', title: '#101: Fix issue' }]);
    providerRegistry.fireRefresh('github-my-prs');

    await vi.waitFor(async () => {
      expect(await linkStore.loadAll()).toHaveLength(0);
    });
    expect(workGraph.getItem(issue.id)?.activityLog?.at(-1)?.type).toBe('item-unlinked');
    expect(workGraph.getItem(pr.id)?.activityLog?.at(-1)?.type).toBe('item-unlinked');
  });

  it('removes links when a linked work item is deleted', async () => {
    const issue = await workGraph.createItem({ title: 'Issue' }, { providerId: 'github', externalId: 'org/repo#1' });
    const pr = await workGraph.createItem({ title: 'PR' }, { providerId: 'github-my-prs', externalId: 'org/repo#101' });
    await linkStore.upsertLink(issue.id, pr.id, 'closes');

    await workGraph.deleteItem(issue.id);

    await vi.waitFor(async () => {
      expect(await linkStore.loadAll()).toHaveLength(0);
    });
    expect(workGraph.getItem(pr.id)?.activityLog?.at(-1)?.type).toBe('item-unlinked');
  });

  it('skips queued reconciliation after disposal', async () => {
    const localWorkGraph = new WorkGraph(createMockStore());
    await localWorkGraph.load();
    const localLinkStore = new ItemLinkStore(new MockMemento());
    await localLinkStore.load();
    const localProviderRegistry = createMockProviderRegistry();
    const localLinkingService = new LinkingService(localWorkGraph, localProviderRegistry as any, localLinkStore);

    localProviderRegistry.getAllDiscoveredItems.mockClear();
    localLinkingService.dispose();

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(localProviderRegistry.getAllDiscoveredItems).not.toHaveBeenCalled();

    localProviderRegistry.dispose();
    localLinkStore.dispose();
    localWorkGraph.dispose();
  });
});

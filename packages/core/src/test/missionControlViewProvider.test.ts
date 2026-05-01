import { beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import type { ITaskStore } from '../storage/taskStore';
import { MissionControlViewProvider } from '../views/missionControlViewProvider';

function createMockStore(): ITaskStore {
  const items = new Map<string, any>();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async item => {
      items.set(item.id, item);
    }),
    saveAll: vi.fn(async batch => {
      for (const item of batch) {
        items.set(item.id, item);
      }
    }),
    delete: vi.fn(async id => {
      items.delete(id);
    }),
  };
}

function createProvider(workGraph: WorkGraph, watcherService: any = {}): MissionControlViewProvider {
  return new MissionControlViewProvider(
    {} as any,
    workGraph,
    {
      getAllDiscoveredItems: () => [],
      getProviderLabel: (providerId: string) => providerId,
      getProviderHealth: () => ({ status: 'healthy' }),
    } as any,
    {
      getState: () => undefined,
      setState: vi.fn(),
    } as any,
    {} as any,
    watcherService,
    {} as any,
  );
}

function getReadyToStartOrder(workGraph: WorkGraph): string[] {
  return workGraph
    .getItemsByState(WorkItemState.New)
    .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER))
    .map(item => item.id);
}

describe('MissionControlViewProvider reorderItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reorders ready-to-start items from a full ordered id list', async () => {
    const workGraph = new WorkGraph(createMockStore());
    const provider = createProvider(workGraph);
    const first = await workGraph.createItem({ title: 'First' });
    const second = await workGraph.createItem({ title: 'Second' });
    const third = await workGraph.createItem({ title: 'Third' });

    await (provider as any).handleReorder([second.id, third.id, first.id]);

    expect(getReadyToStartOrder(workGraph)).toEqual([second.id, third.id, first.id]);
  });

  it('handles reorderItems messages through the webview message switch', async () => {
    const workGraph = new WorkGraph(createMockStore());
    const provider = createProvider(workGraph);
    const first = await workGraph.createItem({ title: 'First' });
    const second = await workGraph.createItem({ title: 'Second' });
    const third = await workGraph.createItem({ title: 'Third' });

    await (provider as any).handleMessage({
      type: 'reorderItems',
      itemIds: [third.id, first.id, second.id],
    });

    expect(getReadyToStartOrder(workGraph)).toEqual([third.id, first.id, second.id]);
  });

  it('ignores stale reorder payloads that do not match the current ready-to-start items', async () => {
    const workGraph = new WorkGraph(createMockStore());
    const provider = createProvider(workGraph);
    const first = await workGraph.createItem({ title: 'First' });
    const second = await workGraph.createItem({ title: 'Second' });
    const third = await workGraph.createItem({ title: 'Third' });

    await (provider as any).handleReorder([first.id, 'missing-item', second.id]);

    expect(getReadyToStartOrder(workGraph)).toEqual([first.id, second.id, third.id]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
});

describe('MissionControlViewProvider CI badges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a passing CI badge when a work item URL matches a watched PR', async () => {
    const workGraph = new WorkGraph(createMockStore());
    const workItem = await workGraph.createItem(
      { title: 'Review PR' },
      { providerId: 'github', externalId: '42', url: 'https://github.com/owner/repo/pull/42' },
    );
    const watcherService = {
      getActiveWatches: vi.fn(() => []),
      getActivePRWatches: vi.fn(() => [{
        identifier: { providerId: 'github-pr', repo: 'owner/repo', prId: '42', displayName: 'PR #42', url: workItem.url },
        prState: 'open',
      }]),
      getPRWatchKey: vi.fn(() => 'pr:github-pr:owner/repo:42'),
      getChildRuns: vi.fn(() => [{
        status: { overallState: 'completed', conclusion: 'success' },
      }]),
    };
    const provider = createProvider(workGraph, watcherService);

    const tiers = (provider as any).buildTierData();
    const readyToStart = tiers.find((tier: any) => tier.id === 'ready-to-start');

    expect(readyToStart.items[0].badges).toContainEqual({
      label: 'CI passed',
      type: 'ci',
      variant: 'ci-pass',
    });
  });

  it('adds a running CI badge when a work item URL matches a watched run', async () => {
    const workGraph = new WorkGraph(createMockStore());
    const workItem = await workGraph.createItem(
      { title: 'Watch CI' },
      { providerId: 'github', externalId: '99', url: 'https://github.com/owner/repo/actions/runs/99' },
    );
    const watcherService = {
      getActiveWatches: vi.fn(() => [{
        identifier: { url: workItem.url },
        status: { overallState: 'running' },
      }]),
      getActivePRWatches: vi.fn(() => []),
      getChildRuns: vi.fn(() => []),
      getPRWatchKey: vi.fn(() => 'unused'),
    };
    const provider = createProvider(workGraph, watcherService);

    const tiers = (provider as any).buildTierData();
    const readyToStart = tiers.find((tier: any) => tier.id === 'ready-to-start');

    expect(readyToStart.items[0].badges).toContainEqual({
      label: 'CI running',
      type: 'ci',
      variant: 'ci-running',
    });
  });
});

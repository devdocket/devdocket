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

function createProvider(workGraph: WorkGraph): MissionControlViewProvider {
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
    {} as any,
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

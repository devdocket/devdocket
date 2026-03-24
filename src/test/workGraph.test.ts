import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

describe('WorkGraph', () => {
  let store: ITaskStore;
  let graph: WorkGraph;

  beforeEach(async () => {
    store = createMockStore();
    // WorkGraph uses vscode.EventEmitter — we need to mock it
    // Since we're running outside VS Code, mock the vscode module
    graph = new WorkGraph(store);
    await graph.load();
  });

  it('creates a work item in New state', async () => {
    const item = await graph.createItem({ title: 'Test' });

    expect(item.title).toBe('Test');
    expect(item.state).toBe(WorkItemState.New);
    expect(item.id).toMatch(/^wc-/);
    expect(store.save).toHaveBeenCalledWith(item);
  });

  it('creates items with unique ids', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });

    expect(a.id).not.toBe(b.id);
  });

  it('gets items by state', async () => {
    await graph.createItem({ title: 'A' });
    await graph.createItem({ title: 'B' });
    const item = await graph.createItem({ title: 'C' });
    await graph.transitionState(item.id, WorkItemState.InProgress);

    const newItems = graph.getItemsByState(WorkItemState.New);
    const activeItems = graph.getItemsByState(WorkItemState.InProgress);

    expect(newItems).toHaveLength(2);
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0].title).toBe('C');
  });

  it('transitions state', async () => {
    const item = await graph.createItem({ title: 'Test' });
    await graph.transitionState(item.id, WorkItemState.InProgress);

    const updated = graph.getItem(item.id);
    expect(updated?.state).toBe(WorkItemState.InProgress);
  });

  it('transitions through full lifecycle', async () => {
    const item = await graph.createItem({ title: 'Lifecycle' });

    await graph.transitionState(item.id, WorkItemState.InProgress);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);

    await graph.transitionState(item.id, WorkItemState.Blocked);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Blocked);

    await graph.transitionState(item.id, WorkItemState.InProgress);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);

    await graph.transitionState(item.id, WorkItemState.Done);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Done);

    await graph.transitionState(item.id, WorkItemState.Archived);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Archived);
  });

  it('throws when transitioning unknown item', async () => {
    await expect(graph.transitionState('nonexistent', WorkItemState.Done))
      .rejects.toThrow('Work item not found');
  });

  it('updates item fields', async () => {
    const item = await graph.createItem({ title: 'Original' });
    await graph.updateItem(item.id, { title: 'Updated' });

    const updated = graph.getItem(item.id);
    expect(updated?.title).toBe('Updated');
  });

  it('throws when updating unknown item', async () => {
    await expect(graph.updateItem('nonexistent', { title: 'X' }))
      .rejects.toThrow('Work item not found');
  });

  it('deletes an item', async () => {
    const item = await graph.createItem({ title: 'Delete me' });
    await graph.deleteItem(item.id);

    expect(graph.getItem(item.id)).toBeUndefined();
    expect(graph.getAll()).toHaveLength(0);
    expect(store.delete).toHaveBeenCalledWith(item.id);
  });

  it('fires change events on create', async () => {
    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.createItem({ title: 'Test' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires change events on state transition', async () => {
    const item = await graph.createItem({ title: 'Test' });
    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.transitionState(item.id, WorkItemState.InProgress);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sets description on create', async () => {
    const item = await graph.createItem({
      title: 'Detailed',
      type: 'Bug',
      description: 'A detailed bug report',
    });

    expect(item.description).toBe('A detailed bug report');
  });
});

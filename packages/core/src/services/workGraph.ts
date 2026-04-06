import * as vscode from 'vscode';
import { WorkItem, WorkItemInput, WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { logger } from './logger';

/**
 * In-memory graph of {@link WorkItem}s backed by a persistent {@link ITaskStore}.
 * Provides CRUD operations, state transitions, and ordering.
 */
export class WorkGraph {
  private readonly items: Map<string, WorkItem> = new Map();
  // Provenance key (`${providerId}::${externalId}`) → WorkItem.id for O(1) lookups
  private readonly provenanceIndex: Map<string, string> = new Map();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /**
   * Fires when this graph changes through public mutation operations exposed by {@link WorkGraph},
   * except for internal maintenance or normalization work that may update items without emitting
   * this event. This includes maintenance performed during load (for example, sort-order backfilling)
   * and normalization triggered as part of a public operation when no user-visible mutation occurs.
   */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: ITaskStore) {}

  private static provenanceKey(providerId: string, externalId: string): string {
    return `${providerId}::${externalId}`;
  }

  /** Load all work items from the backing store into memory. */
  async load(): Promise<void> {
    const items = await this.store.loadAll();
    this.items.clear();
    this.provenanceIndex.clear();
    for (const item of items) {
      this.items.set(item.id, item);
      if (item.providerId && item.externalId) {
        const key = WorkGraph.provenanceKey(item.providerId, item.externalId);
        const existingItemId = this.provenanceIndex.get(key);
        if (existingItemId === undefined) {
          this.provenanceIndex.set(key, item.id);
        } else {
          logger.warn(
            `Duplicate work item provenance detected for ${key}; keeping first loaded item ${existingItemId} and ignoring duplicate ${item.id}`,
          );
        }
      }
    }
    logger.debug(`Loaded ${items.length} work items from store`);
    await this.backfillSortOrder();
  }

  private async backfillSortOrder(): Promise<void> {
    const newItems = this.getItemsByState(WorkItemState.New);
    const unordered = newItems.filter((i) => i.sortOrder === undefined);
    if (unordered.length === 0) {
      return;
    }

    const maxExisting = newItems.reduce(
      (max, i) => Math.max(max, i.sortOrder ?? -1),
      -1,
    );

    // Sort unordered items by title for a stable initial ordering
    unordered.sort((a, b) => a.title.localeCompare(b.title));

    const toSave: WorkItem[] = [];
    for (let i = 0; i < unordered.length; i++) {
      const updated = { ...unordered[i], sortOrder: maxExisting + 1 + i, updatedAt: Date.now() };
      toSave.push(updated);
    }

    await this.store.saveAll(toSave);

    for (const updated of toSave) {
      this.items.set(updated.id, updated);
    }
  }

  /** Return all work items. */
  getAll(): WorkItem[] {
    return Array.from(this.items.values());
  }

  /** Return all work items matching any of the given states. */
  getItemsByState(...states: WorkItemState[]): WorkItem[] {
    return this.getAll().filter((item) => states.includes(item.state));
  }

  /** Return a single work item by ID, or `undefined` if not found. */
  getItem(id: string): WorkItem | undefined {
    return this.items.get(id);
  }

  /** Find a work item by its provider-scoped provenance (provider ID + external ID). */
  findItemByProvenance(providerId: string, externalId: string): WorkItem | undefined {
    const id = this.provenanceIndex.get(WorkGraph.provenanceKey(providerId, externalId));
    return id ? this.items.get(id) : undefined;
  }

  /** Create a new work item, optionally linking it to a provider-discovered source. */
  async createItem(
    input: WorkItemInput,
    provenance?: { providerId: string; externalId: string; url?: string },
  ): Promise<WorkItem> {
    const existingItems = this.getItemsByState(WorkItemState.New);
    // Account for legacy items that may not have sortOrder assigned
    const maxOrder = Math.max(
      existingItems.length - 1,
      existingItems.reduce((max, i) => Math.max(max, i.sortOrder ?? -1), -1),
    );
    const item: WorkItem = {
      id: generateId(),
      title: input.title,
      notes: input.notes,
      state: WorkItemState.New,
      providerId: provenance?.providerId,
      externalId: provenance?.externalId,
      url: provenance?.url,
      sortOrder: maxOrder + 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.save(item);
    this.items.set(item.id, item);
    if (item.providerId && item.externalId) {
      this.provenanceIndex.set(
        WorkGraph.provenanceKey(item.providerId, item.externalId),
        item.id,
      );
    }
    this._onDidChange.fire();
    logger.info(`Created work item: ${item.id}`);
    return item;
  }

  /** Apply a partial update (title and/or notes) to an existing work item. */
  async updateItem(id: string, patch: Partial<WorkItemInput>): Promise<void> {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }
    const updated = { ...item, ...patch, updatedAt: Date.now() };
    await this.store.save(updated);
    this.items.set(id, updated);
    this._onDidChange.fire();
    logger.info(`Updated work item: ${id}`);
  }

  /** Transition a work item to a new lifecycle state. */
  async transitionState(id: string, newState: WorkItemState): Promise<void> {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }
    const updated = { ...item, state: newState, updatedAt: Date.now() };
    await this.store.save(updated);
    this.items.set(id, updated);
    this._onDidChange.fire();
    logger.info(`Transitioned work item ${id} to ${newState}`);
  }

  /** Swap a work item one position up or down among siblings in the same state. */
  async moveItem(id: string, direction: 'up' | 'down'): Promise<void> {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }

    const siblings = this.getItemsByState(item.state)
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

    // Normalize any missing sortOrder values so swaps are consistent
    const toNormalize: WorkItem[] = [];
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].sortOrder === undefined) {
        const normalized = { ...siblings[i], sortOrder: i, updatedAt: Date.now() };
        siblings[i] = normalized;
        toNormalize.push(normalized);
      }
    }
    if (toNormalize.length > 0) {
      await this.store.saveAll(toNormalize);
      for (const normalized of toNormalize) {
        this.items.set(normalized.id, normalized);
      }
    }

    const index = siblings.findIndex((s) => s.id === id);
    if (index === -1) {
      return;
    }

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) {
      return;
    }

    const currentItem = siblings[index];
    const swapItem = siblings[swapIndex];

    const updatedItem = { ...currentItem, sortOrder: swapItem.sortOrder, updatedAt: Date.now() };
    const updatedSwap = { ...swapItem, sortOrder: currentItem.sortOrder, updatedAt: Date.now() };

    await this.store.saveAll([updatedItem, updatedSwap]);
    this.items.set(updatedItem.id, updatedItem);
    this.items.set(updatedSwap.id, updatedSwap);
    this._onDidChange.fire();
  }

  /** Insert a work item before or after a target item (drag-and-drop reorder). */
  async reorderItem(draggedId: string, targetId: string): Promise<void> {
    const dragged = this.items.get(draggedId);
    const target = this.items.get(targetId);
    if (!dragged || !target) { return; }
    if (dragged.state !== target.state) { return; }
    if (draggedId === targetId) { return; }

    const siblings= this.getItemsByState(dragged.state)
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

    const draggedIndex = siblings.findIndex(s => s.id === draggedId);
    const targetIndex = siblings.findIndex(s => s.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) { return; }

    const withoutDragged = siblings.filter(s => s.id !== draggedId);
    const newTargetIndex = withoutDragged.findIndex(s => s.id === targetId);

    // Insert after target when dragging down, before target when dragging up
    const insertIndex = draggedIndex < targetIndex ? newTargetIndex + 1 : newTargetIndex;
    withoutDragged.splice(insertIndex, 0, dragged);

    const itemsToSave: WorkItem[] = [];
    withoutDragged.forEach((item, i) => {
      if (item.sortOrder !== i) {
        const updated = { ...item, sortOrder: i, updatedAt: Date.now() };
        itemsToSave.push(updated);
      }
    });

    if (itemsToSave.length > 0) {
      await this.store.saveAll(itemsToSave);
      for (const updated of itemsToSave) {
        this.items.set(updated.id, updated);
      }
      this._onDidChange.fire();
    }
  }

  /** Move a work item to the last position among siblings in the same state. */
  async moveToEnd(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) { return; }

    const siblings = this.getItemsByState(item.state)
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

    if (siblings.length === 0) { return; }

    const lastSibling = siblings[siblings.length - 1];
    if (lastSibling.id === item.id) { return; }

    // Re-index siblings with the item moved to the end to keep orders compact
    const withoutItem = siblings.filter(s => s.id !== item.id);
    withoutItem.push(item);

    const itemsToSave: WorkItem[] = [];
    withoutItem.forEach((sibling, index) => {
      if (sibling.sortOrder !== index) {
        const updated = { ...sibling, sortOrder: index, updatedAt: Date.now() };
        itemsToSave.push(updated);
      }
    });

    if (itemsToSave.length > 0) {
      await this.store.saveAll(itemsToSave);
      for (const updated of itemsToSave) {
        this.items.set(updated.id, updated);
      }
      this._onDidChange.fire();
    }
  }

  /** Permanently delete a work item from the store. */
  async deleteItem(id: string): Promise<void> {
    const item = this.items.get(id);
    await this.store.delete(id);
    if (item?.providerId && item?.externalId) {
      this.provenanceIndex.delete(
        WorkGraph.provenanceKey(item.providerId, item.externalId),
      );
    }
    this.items.delete(id);
    this._onDidChange.fire();
    logger.info(`Deleted work item: ${id}`);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function generateId(): string {
  return `wc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

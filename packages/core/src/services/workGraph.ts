import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WorkItem, WorkItemInput, WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { logger } from './logger';

const VALID_TRANSITIONS: ReadonlyMap<WorkItemState, ReadonlySet<WorkItemState>> = new Map([
  [WorkItemState.New, new Set([WorkItemState.InProgress, WorkItemState.Archived])],
  [WorkItemState.InProgress, new Set([WorkItemState.Paused, WorkItemState.Done, WorkItemState.New, WorkItemState.Archived])],
  [WorkItemState.Paused, new Set([WorkItemState.InProgress, WorkItemState.New, WorkItemState.Archived])],
  [WorkItemState.Done, new Set([WorkItemState.Archived])],
  [WorkItemState.Archived, new Set<WorkItemState>()],
]);

/**
 * In-memory graph of {@link WorkItem}s backed by a persistent {@link ITaskStore}.
 * Provides CRUD operations, state transitions, and ordering.
 */
export class WorkGraph {
  private readonly items: Map<string, WorkItem> = new Map();
  // Provenance key (`${providerId}::${externalId}`) → WorkItem.id for O(1) lookups
  private readonly provenanceIndex: Map<string, string> = new Map();
  // Provenance key → count of extra (unindexed) items sharing that key
  private readonly duplicateProvenanceCounts: Map<string, number> = new Map();
  /** Lazily-built index of items grouped by state; nulled on any mutation to {@link items}. */
  private stateCache: Map<WorkItemState, WorkItem[]> | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  private _suppressChangeEvents = false;
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
    this.duplicateProvenanceCounts.clear();
    for (const item of items) {
      this.items.set(item.id, item);
      if (item.providerId && item.externalId) {
        const key = WorkGraph.provenanceKey(item.providerId, item.externalId);
        const existingItemId = this.provenanceIndex.get(key);
        if (existingItemId === undefined) {
          this.provenanceIndex.set(key, item.id);
        } else {
          this.duplicateProvenanceCounts.set(key, (this.duplicateProvenanceCounts.get(key) ?? 0) + 1);
          logger.warn(
            `Duplicate work item provenance detected for ${key}; keeping first loaded item ${existingItemId} and ignoring duplicate ${item.id}`,
          );
        }
      }
    }
    this.invalidateStateCache();
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
    this.invalidateStateCache();
  }

  /** Return the next available sortOrder for items in the given state. */
  private nextSortOrder(state: WorkItemState): number {
    const items = this.getItemsByState(state);
    // Account for legacy items that may not have sortOrder assigned
    const maxOrder = Math.max(
      items.length - 1,
      items.reduce((max, i) => Math.max(max, i.sortOrder ?? -1), -1),
    );
    return maxOrder + 1;
  }

  /** Return all work items. */
  getAll(): WorkItem[] {
    return Array.from(this.items.values());
  }

  private invalidateStateCache(): void {
    this.stateCache = null;
  }

  private getOrBuildStateCache(): Map<WorkItemState, WorkItem[]> {
    if (this.stateCache) return this.stateCache;

    const cache = new Map<WorkItemState, WorkItem[]>();
    for (const item of this.items.values()) {
      const list = cache.get(item.state);
      if (list) {
        list.push(item);
      } else {
        cache.set(item.state, [item]);
      }
    }
    this.stateCache = cache;
    return cache;
  }

  /** Return all work items matching any of the given states. */
  getItemsByState(...states: WorkItemState[]): WorkItem[] {
    if (states.length === 0) {
      return [];
    }
    if (states.length === 1) {
      const cache = this.getOrBuildStateCache();
      return [...(cache.get(states[0]) ?? [])];
    }
    const requestedStates = new Set(states);
    const result: WorkItem[] = [];
    for (const item of this.items.values()) {
      if (requestedStates.has(item.state)) {
        result.push(item);
      }
    }
    return result;
  }

  /** Return a single work item by ID, or `undefined` if not found. */
  getItem(id: string): WorkItem | undefined {
    return this.items.get(id);
  }

  /** Find a work item by its provider-scoped provenance (provider ID + external ID). */
  findItemByProvenance(providerId: string, externalId: string): WorkItem | undefined {
    const id = this.provenanceIndex.get(WorkGraph.provenanceKey(providerId, externalId));
    return id !== undefined ? this.items.get(id) : undefined;
  }

  /** Create a new work item, optionally linking it to a provider-discovered source. */
  async createItem(
    input: WorkItemInput,
    provenance?: { providerId: string; externalId: string; url?: string; group?: string },
  ): Promise<WorkItem> {
    const sortOrder = this.nextSortOrder(WorkItemState.New);
    const item: WorkItem = {
      id: generateId(),
      title: input.title,
      notes: input.notes,
      state: WorkItemState.New,
      providerId: provenance?.providerId,
      externalId: provenance?.externalId,
      url: provenance?.url,
      group: provenance?.group,
      sortOrder,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.save(item);
    this.items.set(item.id, item);
    if (item.providerId && item.externalId) {
      const key = WorkGraph.provenanceKey(item.providerId, item.externalId);
      const existingId = this.provenanceIndex.get(key);
      if (existingId === undefined) {
        this.provenanceIndex.set(key, item.id);
      } else {
        this.duplicateProvenanceCounts.set(key, (this.duplicateProvenanceCounts.get(key) ?? 0) + 1);
        logger.warn(
          `Duplicate work item provenance detected for ${key}; ` +
            `keeping existing item ${existingId} indexed and leaving new item ${item.id} unindexed by provenance.`,
        );
      }
    }
    this.invalidateStateCache();
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
    this.invalidateStateCache();
    this._onDidChange.fire();
    logger.info(`Updated work item: ${id}`);
  }

  /** Transition a work item to a new lifecycle state. */
  async transitionState(id: string, newState: WorkItemState): Promise<void> {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }
    if (!Object.values(WorkItemState).includes(newState)) {
      throw new Error(`Invalid state value: ${String(newState)}. Expected one of: ${Object.values(WorkItemState).join(', ')}`);
    }
    const allowedTargets = VALID_TRANSITIONS.get(item.state);
    if (!allowedTargets || !allowedTargets.has(newState)) {
      throw new Error(
        `Invalid state transition: cannot move from ${item.state} to ${newState}`,
      );
    }
    const updated: WorkItem = { ...item, state: newState, updatedAt: Date.now() };
    // When returning to Queue, assign a fresh sortOrder to avoid collisions
    if (newState === WorkItemState.New) {
      updated.sortOrder = this.nextSortOrder(WorkItemState.New);
    }
    await this.store.save(updated);
    this.items.set(id, updated);
    this.invalidateStateCache();
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

    // Normalize sortOrder values to sequential indices so swaps are consistent
    // even when items have duplicate or missing sortOrder (e.g. after state transitions)
    let didMutate = false;
    const toNormalize: WorkItem[] = [];
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].sortOrder !== i) {
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
      this.invalidateStateCache();
      didMutate = true;
    }

    const index = siblings.findIndex((s) => s.id === id);
    if (index === -1) {
      if (didMutate) { this._onDidChange.fire(); }
      return;
    }

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) {
      if (didMutate) { this._onDidChange.fire(); }
      return;
    }

    const currentItem = siblings[index];
    const swapItem = siblings[swapIndex];

    const updatedItem = { ...currentItem, sortOrder: swapItem.sortOrder, updatedAt: Date.now() };
    const updatedSwap = { ...swapItem, sortOrder: currentItem.sortOrder, updatedAt: Date.now() };

    await this.store.saveAll([updatedItem, updatedSwap]);
    this.items.set(updatedItem.id, updatedItem);
    this.items.set(updatedSwap.id, updatedSwap);
    this.invalidateStateCache();
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
      this.invalidateStateCache();
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
      this.invalidateStateCache();
      this._onDidChange.fire();
    }
  }

  /**
   * Delete all history items (Done and Archived) whose `updatedAt` is older than the given age in days.
   * Returns the number of items deleted.
   */
  async clearOldHistory(maxAgeDays: number): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const toDelete = this.getItemsByState(WorkItemState.Done, WorkItemState.Archived)
      .filter(item => item.updatedAt < cutoff);

    if (toDelete.length === 0) {
      return 0;
    }

    let deleted = 0;
    this._suppressChangeEvents = true;
    try {
      for (const item of toDelete) {
        try {
          await this.deleteItem(item.id);
          deleted++;
        } catch (err) {
          logger.warn(`Failed to delete history item ${item.id}, skipping`);
        }
      }
    } finally {
      this._suppressChangeEvents = false;
      if (deleted > 0) {
        this._onDidChange.fire();
      }
    }

    return deleted;
  }

  /** Permanently delete a work item from the store. */
  async deleteItem(id: string): Promise<void> {
    const item = this.items.get(id);
    await this.store.delete(id);
    if (item?.providerId && item?.externalId) {
      const key = WorkGraph.provenanceKey(item.providerId, item.externalId);
      const dupCount = this.duplicateProvenanceCounts.get(key) ?? 0;
      if (this.provenanceIndex.get(key) === id) {
        if (dupCount > 0) {
          // Scan for a replacement among remaining duplicates
          let replacementId: string | undefined;
          for (const [candidateId, candidate] of this.items) {
            if (
              candidateId !== id &&
              candidate.providerId === item.providerId &&
              candidate.externalId === item.externalId
            ) {
              replacementId = candidateId;
              break;
            }
          }

          if (replacementId !== undefined) {
            this.provenanceIndex.set(key, replacementId);
          } else {
            this.provenanceIndex.delete(key);
          }
          this.decrementDuplicateCount(key);
        } else {
          this.provenanceIndex.delete(key);
        }
      } else if (dupCount > 0) {
        // Deleting an unindexed duplicate — decrement the count
        this.decrementDuplicateCount(key);
      }
    }
    this.items.delete(id);
    this.invalidateStateCache();
    if (!this._suppressChangeEvents) {
      this._onDidChange.fire();
    }
    logger.info(`Deleted work item: ${id}`);
  }

  private decrementDuplicateCount(key: string): void {
    const count = this.duplicateProvenanceCounts.get(key) ?? 0;
    if (count <= 1) {
      this.duplicateProvenanceCounts.delete(key);
    } else {
      this.duplicateProvenanceCounts.set(key, count - 1);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function generateId(): string {
  return `wc-${crypto.randomUUID()}`;
}

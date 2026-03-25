import * as vscode from 'vscode';
import { WorkItem, WorkItemInput, WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { logger } from './logger';

export class WorkGraph {
  private items: Map<string, WorkItem> = new Map();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: ITaskStore) {}

  async load(): Promise<void> {
    const items = await this.store.loadAll();
    this.items.clear();
    for (const item of items) {
      this.items.set(item.id, item);
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
      this.items.set(updated.id, updated);
      toSave.push(updated);
    }
    await this.store.saveAll(toSave);
  }

  getAll(): WorkItem[] {
    return Array.from(this.items.values());
  }

  getItemsByState(...states: WorkItemState[]): WorkItem[] {
    return this.getAll().filter((item) => states.includes(item.state));
  }

  getItem(id: string): WorkItem | undefined {
    return this.items.get(id);
  }

  findItemByProvenance(providerId: string, externalId: string): WorkItem | undefined {
    return this.getAll().find(
      (item) => item.providerId === providerId && item.externalId === externalId
    );
  }

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
      description: input.description,
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
    this._onDidChange.fire();
    logger.info(`Created work item: ${item.id}`);
    return item;
  }

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
        this.items.set(normalized.id, normalized);
        toNormalize.push(normalized);
      }
    }
    if (toNormalize.length > 0) {
      await this.store.saveAll(toNormalize);
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

  async reorderItem(draggedId: string, targetId: string): Promise<void> {
    const dragged = this.items.get(draggedId);
    const target = this.items.get(targetId);
    if (!dragged || !target) { return; }

    const siblings = this.getItemsByState(dragged.state)
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

    const withoutDragged = siblings.filter(s => s.id !== draggedId);
    const targetIndex = withoutDragged.findIndex(s => s.id === targetId);
    if (targetIndex === -1) { return; }

    withoutDragged.splice(targetIndex, 0, dragged);

    const itemsToSave: WorkItem[] = [];
    withoutDragged.forEach((item, i) => {
      if (item.sortOrder !== i) {
        const updated = { ...item, sortOrder: i, updatedAt: Date.now() };
        this.items.set(updated.id, updated);
        itemsToSave.push(updated);
      }
    });

    if (itemsToSave.length > 0) {
      await this.store.saveAll(itemsToSave);
      this._onDidChange.fire();
    }
  }

  async deleteItem(id: string): Promise<void> {
    await this.store.delete(id);
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

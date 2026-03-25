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
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));

    // Normalize any missing sortOrder values so swaps are consistent
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].sortOrder === undefined) {
        const normalized = { ...siblings[i], sortOrder: i, updatedAt: Date.now() };
        siblings[i] = normalized;
        this.items.set(normalized.id, normalized);
        await this.store.save(normalized);
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

    await this.store.save(updatedItem);
    await this.store.save(updatedSwap);
    this.items.set(updatedItem.id, updatedItem);
    this.items.set(updatedSwap.id, updatedSwap);
    this._onDidChange.fire();
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

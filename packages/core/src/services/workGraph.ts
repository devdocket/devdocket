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
    const item: WorkItem = {
      id: generateId(),
      title: input.title,
      description: input.description,
      state: WorkItemState.New,
      providerId: provenance?.providerId,
      externalId: provenance?.externalId,
      url: provenance?.url,
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

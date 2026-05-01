import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import type { RelatedItemRef } from '../api/types';
import { logger } from '../services/logger';
import {
  validateObject,
  requiredString,
  requiredEnum,
} from './validation';

const STORAGE_KEY = 'devdocket.itemLinks';
const validRelations = new Set<string>(['closes', 'linked']);
const validOrigins = new Set<string>(['provider']);

export type ItemLinkRelation = RelatedItemRef['relation'];
export type ItemLinkOrigin = 'provider';

export interface ItemLink {
  id: string;
  itemId1: string;
  itemId2: string;
  relation: ItemLinkRelation;
  origin: ItemLinkOrigin;
  /** The item that declared the relationship (e.g., the PR that says "Closes #N"). */
  sourceItemId?: string;
}

function validateItemLink(value: unknown, index: number): string | undefined {
  const result = validateObject(value, `Link at index ${index}`);
  if (typeof result === 'string') return result;

  const ctx = `Link at index ${index}`;
  return requiredString(result, 'id', ctx)
    ?? requiredString(result, 'itemId1', ctx)
    ?? requiredString(result, 'itemId2', ctx)
    ?? requiredEnum(result, 'relation', validRelations, ctx)
    ?? requiredEnum(result, 'origin', validOrigins, ctx);
}

export class ItemLinkStore {
  private readonly globalState: Memento;
  private readonly cache = new Map<string, ItemLink>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private loaded = false;

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  static pairKey(itemId1: string, itemId2: string): string {
    return [itemId1, itemId2].sort((a, b) => a.localeCompare(b)).join('::');
  }

  private static normalizePair(itemId1: string, itemId2: string): [string, string] {
    return itemId1.localeCompare(itemId2) <= 0 ? [itemId1, itemId2] : [itemId2, itemId1];
  }

  private async persist(): Promise<void> {
    await this.globalState.update(STORAGE_KEY, Array.from(this.cache.values()));
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
    this.cache.clear();
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) {
        const error = validateItemLink(parsed[i], i);
        if (error) {
          logger.warn(`Skipping invalid item link: ${error}`);
          continue;
        }
        const link = parsed[i] as ItemLink;
        const [itemId1, itemId2] = ItemLinkStore.normalizePair(link.itemId1, link.itemId2);
        this.cache.set(ItemLinkStore.pairKey(itemId1, itemId2), { ...link, itemId1, itemId2 });
      }
    }

    this.loaded = true;
  }

  async loadAll(): Promise<ItemLink[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  getLinkBetween(itemId1: string, itemId2: string): ItemLink | undefined {
    return this.cache.get(ItemLinkStore.pairKey(itemId1, itemId2));
  }

  getLinksForItem(itemId: string): ItemLink[] {
    return Array.from(this.cache.values()).filter(link => link.itemId1 === itemId || link.itemId2 === itemId);
  }

  async upsertLink(
    itemId1: string,
    itemId2: string,
    relation: ItemLinkRelation,
    origin: ItemLinkOrigin = 'provider',
    sourceItemId?: string,
  ): Promise<{ link: ItemLink; created: boolean; updated: boolean } | undefined> {
    if (itemId1 === itemId2) {
      return undefined;
    }
    await this.load();
    const [normalizedItemId1, normalizedItemId2] = ItemLinkStore.normalizePair(itemId1, itemId2);
    const key = ItemLinkStore.pairKey(normalizedItemId1, normalizedItemId2);
    const existing = this.cache.get(key);
    if (existing) {
      if (existing.relation === relation && existing.origin === origin && existing.sourceItemId === sourceItemId) {
        return { link: existing, created: false, updated: false };
      }

      const updated: ItemLink = {
        ...existing,
        itemId1: normalizedItemId1,
        itemId2: normalizedItemId2,
        relation,
        origin,
        sourceItemId,
      };
      this.cache.set(key, updated);
      await this.persist();
      this._onDidChange.fire();
      return { link: updated, created: false, updated: true };
    }

    const createdLink: ItemLink = {
      id: `link-${crypto.randomUUID()}`,
      itemId1: normalizedItemId1,
      itemId2: normalizedItemId2,
      relation,
      origin,
      sourceItemId,
    };
    this.cache.set(key, createdLink);
    await this.persist();
    this._onDidChange.fire();
    return { link: createdLink, created: true, updated: false };
  }

  async deleteLink(itemId1: string, itemId2: string): Promise<ItemLink | undefined> {
    await this.load();
    const key = ItemLinkStore.pairKey(itemId1, itemId2);
    const existing = this.cache.get(key);
    if (!existing) {
      return undefined;
    }

    this.cache.delete(key);
    await this.persist();
    this._onDidChange.fire();
    return existing;
  }

  async removeLinksForItem(itemId: string): Promise<ItemLink[]> {
    await this.load();
    const removed = this.getLinksForItem(itemId);
    if (removed.length === 0) {
      return [];
    }

    for (const link of removed) {
      this.cache.delete(ItemLinkStore.pairKey(link.itemId1, link.itemId2));
    }
    await this.persist();
    this._onDidChange.fire();
    return removed;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

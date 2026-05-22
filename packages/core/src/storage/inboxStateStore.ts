import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { logger } from '../services/logger';
import type { FileStore } from './fileStore';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
} from './validation';

/** Possible states for a provider-discovered item in the inbox workflow. */
const inboxStates = ['unseen', 'accepted', 'dismissed'] as const;

export type InboxState = (typeof inboxStates)[number];

const validInboxStates = new Set<string>(inboxStates);

/** Persisted mapping of a provider item to its inbox state. */
export interface InboxStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;
  /** Version identifier used to detect when a previously accepted item needs re-attention. */
  version?: string;
  /** Secondary version identifier tracked independently from `version`. */
  resurfaceVersion?: string;
}

/**
 * Validates that a parsed JSON value has the required shape of an InboxStateRecord.
 * Returns a descriptive error string if invalid, or undefined if valid.
 */
function validateInboxStateRecord(value: unknown, index: number): string | undefined {
  const result = validateObject(value, `Record at index ${index}`);
  if (typeof result === 'string') return result;

  const ctx = `Record at index ${index}`;
  return requiredString(result, 'providerId', ctx)
    ?? requiredString(result, 'externalId', ctx)
    ?? requiredEnum(result, 'inboxState', validInboxStates, ctx)
    ?? optionalString(result, 'version', ctx)
    ?? optionalString(result, 'resurfaceVersion', ctx);
}

/**
 * Persists inbox-state records (`unseen | accepted | dismissed`) for
 * provider-discovered items in a JSON file under globalStorageUri.
 *
 * Only the state enum is stored — item data (title, description, url) is
 * always read live from the provider.
 */
export class InboxStateStore {
  private readonly cache = new Map<string, InboxStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private loaded = false;
  /** Keys modified locally since the last load/persist. */
  private dirtyKeys = new Set<string>();
  /** Keys removed locally since the last load/persist. */
  private removedKeys = new Set<string>();

  constructor(private readonly fileStore: FileStore<unknown[]>) {}

  private key(providerId: string, externalId: string): string {
    return `${providerId}::${externalId}`;
  }

  /**
   * Returns the current inbox state for a discovered item, or `undefined` if unknown.
   */
  getState(providerId: string, externalId: string): InboxState | undefined {
    return this.cache.get(this.key(providerId, externalId))?.inboxState;
  }

  /**
   * Returns the stored version for a discovered item, or `undefined` if not set.
   */
  getVersion(providerId: string, externalId: string): string | undefined {
    return this.cache.get(this.key(providerId, externalId))?.version;
  }

  /**
   * Returns the stored resurface version for a discovered item, or `undefined` if not set.
   */
  getResurfaceVersion(providerId: string, externalId: string): string | undefined {
    return this.cache.get(this.key(providerId, externalId))?.resurfaceVersion;
  }

  /**
   * Re-reads from disk, merges remote records with local mutations, and writes
   * the merged result. Untouched keys adopt the remote view, locally changed
   * keys win, and locally removed keys stay removed.
   */
  private async persist(): Promise<void> {
    const merged = new Map<string, InboxStateRecord>();

    for (const remote of await this.parseFromFileStore()) {
      merged.set(this.key(remote.providerId, remote.externalId), remote);
    }

    for (const k of this.removedKeys) {
      merged.delete(k);
    }

    for (const k of this.dirtyKeys) {
      const local = this.cache.get(k);
      if (local) {
        merged.set(k, local);
      }
    }

    await this.fileStore.write(Array.from(merged.values()));
    this.cache.clear();
    for (const [k, record] of merged) {
      this.cache.set(k, record);
    }
    this.dirtyKeys.clear();
    this.removedKeys.clear();
  }

  /** Parse and validate inbox state records from the backing JSON file. */
  private async parseFromFileStore(): Promise<InboxStateRecord[]> {
    const parsed = await this.fileStore.read();
    if (!Array.isArray(parsed)) { return []; }
    const records: InboxStateRecord[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const error = validateInboxStateRecord(parsed[i], i);
      if (error) {
        logger.warn(`Skipping invalid inbox state record: ${error}`);
        continue;
      }
      records.push(parsed[i] as InboxStateRecord);
    }
    return records;
  }

  /**
   * Sets the inbox state for a single discovered item and persists to disk.
   *
   * Note: `resurfaceVersion` is only settable via `setStates()`, not here.
   * This method preserves any existing `resurfaceVersion` from the previous record.
   */
  async setState(providerId: string, externalId: string, state: InboxState, version?: string): Promise<void> {
    if (!this.loaded) { await this.load(); }
    const k = this.key(providerId, externalId);
    const previousValue = this.cache.get(k);
    const newRecord: InboxStateRecord = { providerId, externalId, inboxState: state };
    if (version !== undefined) {
      newRecord.version = version;
    } else if (previousValue?.version !== undefined) {
      newRecord.version = previousValue.version;
    }
    if (previousValue?.resurfaceVersion !== undefined) {
      newRecord.resurfaceVersion = previousValue.resurfaceVersion;
    }
    this.cache.set(k, newRecord);
    this.dirtyKeys.add(k);
    this.removedKeys.delete(k);
    await this.persist();
    this._onDidChange.fire();
  }

  /**
   * Sets the inbox state for multiple discovered items in a single write.
   */
  async setStates(items: Array<{ providerId: string; externalId: string; state: InboxState; version?: string; resurfaceVersion?: string }>): Promise<void> {
    if (!this.loaded) { await this.load(); }
    if (items.length === 0) { return; }
    for (const item of items) {
      const k = this.key(item.providerId, item.externalId);
      const previousRecord = this.cache.get(k);
      const newRecord: InboxStateRecord = { providerId: item.providerId, externalId: item.externalId, inboxState: item.state };
      if (item.version !== undefined) {
        newRecord.version = item.version;
      } else if (previousRecord?.version !== undefined) {
        newRecord.version = previousRecord.version;
      }
      if (item.resurfaceVersion !== undefined) {
        newRecord.resurfaceVersion = item.resurfaceVersion;
      } else if (previousRecord?.resurfaceVersion !== undefined) {
        newRecord.resurfaceVersion = previousRecord.resurfaceVersion;
      }
      this.cache.set(k, newRecord);
      this.dirtyKeys.add(k);
      this.removedKeys.delete(k);
    }
    await this.persist();
    this._onDidChange.fire();
  }

  /**
   * Returns all persisted state records, loading from disk on first call.
   */
  async loadAll(): Promise<InboxStateRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  /**
   * Loads state records from disk into the cache. No-ops if already loaded.
   */
  async load(): Promise<void> {
    if (this.loaded) { return; }
    this.cache.clear();
    const records = await this.parseFromFileStore();
    for (const record of records) {
      this.cache.set(this.key(record.providerId, record.externalId), record);
    }
    this.dirtyKeys.clear();
    this.removedKeys.clear();
    if (records.length > 0) {
      logger.debug(`Loaded inbox state: ${this.cache.size} entries`);
    }
    this.loaded = true;
  }

  /**
   * Removes persisted state records for items that are no longer reported by
   * their provider. Providers with empty item arrays are skipped to avoid
   * pruning during transient API failures.
   *
   * @returns The number of records removed.
   */
  async prune(activeItems: Map<string, ProviderItem[]>): Promise<number> {
    if (!this.loaded) { await this.load(); }

    // Build a set of active composite keys and collect provider IDs that
    // actually have items. Providers with empty arrays are excluded so their
    // records survive transient failures.
    const activeKeys = new Set<string>();
    const activeProviderIds = new Set<string>();
    for (const [providerId, items] of activeItems) {
      if (items.length === 0) { continue; }
      activeProviderIds.add(providerId);
      for (const item of items) {
        activeKeys.add(this.key(providerId, item.externalId));
      }
    }

    if (activeProviderIds.size === 0) { return 0; }

    const staleKeys: string[] = [];
    for (const [k, record] of this.cache) {
      if (activeProviderIds.has(record.providerId) && !activeKeys.has(k)) {
        staleKeys.push(k);
      }
    }

    if (staleKeys.length === 0) { return 0; }

    for (const k of staleKeys) {
      this.cache.delete(k);
      this.removedKeys.add(k);
      this.dirtyKeys.delete(k);
    }

    await this.persist();
    this._onDidChange.fire();
    return staleKeys.length;
  }

  /** Disposes the change event emitter. */
  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * Invalidates the in-memory cache so the next mutation re-reads from disk.
   * Used for cross-window change propagation.
   */
  invalidateCache(): void {
    this.cache.clear();
    this.dirtyKeys.clear();
    this.removedKeys.clear();
    this.loaded = false;
  }
}

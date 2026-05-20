import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import type { ProviderItem } from '../api/types';
import { logger } from '../services/logger';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
} from './validation';

const STORAGE_KEY = 'devdocket.inbox-state';

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
 * provider-discovered items in VS Code globalState.
 *
 * Only the state enum is stored — item data (title, description, url) is
 * always read live from the provider.
 */
export class InboxStateStore {
  private readonly globalState: Memento;
  private readonly cache = new Map<string, InboxStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private loaded = false;
  /** Keys known at load time — used to distinguish "pruned locally" from "added remotely". */
  private loadedKeys = new Set<string>();

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

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
   * Re-reads from globalState, merges remote records with the local cache,
   * and writes the merged result. Local changes take precedence for the same key.
   * Remote additions (keys not known at load time) are preserved.
   */
  private async persist(): Promise<void> {
    const remoteRecords = this.parseFromGlobalState();
    const merged = new Map(this.cache);

    for (const remote of remoteRecords) {
      const k = this.key(remote.providerId, remote.externalId);
      if (!merged.has(k) && !this.loadedKeys.has(k)) {
        // Remote has a record we never saw — added by another window
        merged.set(k, remote);
      }
      // else: local cache has it (local wins) or we pruned it (stay pruned)
    }

    // Update cache and tracking
    this.cache.clear();
    for (const [k, record] of merged) {
      this.cache.set(k, record);
    }
    this.loadedKeys = new Set(merged.keys());
    await this.globalState.update(STORAGE_KEY, Array.from(merged.values()));
  }

  /** Parse and validate inbox state records from globalState. */
  private parseFromGlobalState(): InboxStateRecord[] {
    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
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
   * Sets the inbox state for a single discovered item and persists to globalState.
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
    }
    await this.persist();
    this._onDidChange.fire();
  }

  /**
   * Returns all persisted state records, loading from globalState on first call.
   */
  async loadAll(): Promise<InboxStateRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  /**
   * Loads state records from globalState into the cache. No-ops if already loaded.
   */
  async load(): Promise<void> {
    if (this.loaded) { return; }
    this.cache.clear();
    const records = this.parseFromGlobalState();
    for (const record of records) {
      this.cache.set(this.key(record.providerId, record.externalId), record);
    }
    this.loadedKeys = new Set(this.cache.keys());
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
   * Invalidates the in-memory cache so the next mutation re-reads from
   * globalState. Used for cross-window change propagation.
   */
  invalidateCache(): void {
    this.cache.clear();
    this.loadedKeys.clear();
    this.loaded = false;
  }
}

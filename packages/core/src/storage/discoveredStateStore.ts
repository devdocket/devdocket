import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import type { DiscoveredItem } from '../api/types';
import { logger } from '../services/logger';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
} from './validation';

const STORAGE_KEY = 'devdocket.discovered-state';

/** Possible states for a provider-discovered item in the inbox workflow. */
const inboxStates = ['unseen', 'accepted', 'dismissed'] as const;

export type InboxState = (typeof inboxStates)[number];

const validInboxStates = new Set<string>(inboxStates);

/** Persisted mapping of a provider item to its inbox state. */
export interface DiscoveredStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;
  /** Version identifier used to detect when a previously accepted item needs re-attention. */
  version?: string;
  /** Secondary version identifier tracked independently from `version`. */
  resurfaceVersion?: string;
}

/**
 * Validates that a parsed JSON value has the required shape of a DiscoveredStateRecord.
 * Returns a descriptive error string if invalid, or undefined if valid.
 */
function validateDiscoveredStateRecord(value: unknown, index: number): string | undefined {
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
export class DiscoveredStateStore {
  private readonly globalState: Memento;
  private readonly cache = new Map<string, DiscoveredStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private loaded = false;

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

  private async persist(): Promise<void> {
    await this.globalState.update(STORAGE_KEY, Array.from(this.cache.values()));
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
    const newRecord: DiscoveredStateRecord = { providerId, externalId, inboxState: state };
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
      const newRecord: DiscoveredStateRecord = { providerId: item.providerId, externalId: item.externalId, inboxState: item.state };
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
  async loadAll(): Promise<DiscoveredStateRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  /**
   * Loads state records from globalState into the cache. No-ops if already loaded.
   */
  async load(): Promise<void> {
    if (this.loaded) { return; }
    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
    this.cache.clear();
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) {
        const error = validateDiscoveredStateRecord(parsed[i], i);
        if (error) {
          logger.warn(`Skipping invalid discovered state record: ${error}`);
          continue;
        }
        const record = parsed[i] as DiscoveredStateRecord;
        this.cache.set(this.key(record.providerId, record.externalId), record);
      }
      logger.debug(`Loaded discovered state: ${this.cache.size} entries`);
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
  async prune(activeItems: Map<string, DiscoveredItem[]>): Promise<number> {
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
}

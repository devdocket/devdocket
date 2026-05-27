import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { logger } from '../services/logger';
import type { FileStore } from './fileStore';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
  optionalFiniteNumber,
} from './validation';
import { trimByAge } from './trimByAge';

/** Possible states for a provider-discovered item in the inbox workflow. */
const inboxStates = ['unseen', 'accepted', 'dismissed'] as const;
const MAX_TOTAL_ENTRIES = 5_000;

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

interface PersistedInboxStateRecord extends InboxStateRecord {
  /** Legacy field name: stores the last-write timestamp used for eviction so recently updated inbox decisions survive trimming. */
  createdAt: number;
}

interface InboxStateSnapshot {
  records: PersistedInboxStateRecord[];
  available: boolean;
}

function toInboxStateRecord(record: PersistedInboxStateRecord): InboxStateRecord {
  const { createdAt: _createdAt, ...publicRecord } = record;
  return publicRecord;
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
    ?? optionalString(result, 'resurfaceVersion', ctx)
    ?? optionalFiniteNumber(result, 'createdAt', ctx);
}

/**
 * Persists inbox-state records (`unseen | accepted | dismissed`) for
 * provider-discovered items in a JSON file under globalStorageUri.
 *
 * Only the state enum is stored — item data (title, description, url) is
 * always read live from the provider.
 */
export class InboxStateStore {
  private readonly cache = new Map<string, PersistedInboxStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidPersist = new vscode.EventEmitter<void>();
  readonly onDidPersist = this._onDidPersist.event;
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInProgress: Promise<void> | undefined;
  private disposed = false;
  /** Keys modified locally since the last load/persist. */
  private dirtyKeys = new Set<string>();
  /** Keys removed locally since the last load/persist. */
  private removedKeys = new Set<string>();

  constructor(
    private readonly fileStore: FileStore<unknown[]>,
    private readonly persistDebounceMs = 250,
  ) {}

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

  private hasPendingPersist(): boolean {
    return this.dirtyKeys.size > 0 || this.removedKeys.size > 0;
  }

  private schedulePersist(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (this.persistDebounceMs <= 0) {
      return this.flush();
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush().catch(err => logger.error('Failed to flush debounced inbox state persistence', err));
    }, this.persistDebounceMs);
    return Promise.resolve();
  }

  /** Flushes any pending debounced persistence immediately. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    if (this.flushInProgress) {
      await this.flushInProgress;
    }

    if (!this.hasPendingPersist()) {
      return;
    }

    this.flushInProgress = this.persist().finally(() => {
      this.flushInProgress = undefined;
    });
    await this.flushInProgress;

    if (this.hasPendingPersist()) {
      await this.flush();
    }
  }

  /**
   * Re-reads from disk, merges remote records with local mutations, and writes
   * the merged result. Untouched keys adopt the remote view, locally changed
   * keys win, and locally removed keys stay removed.
   */
  private async persist(): Promise<void> {
    const dirtyKeys = new Set(this.dirtyKeys);
    const removedKeys = new Set(this.removedKeys);
    const dirtyRecords = new Map<string, PersistedInboxStateRecord>();
    for (const k of dirtyKeys) {
      const local = this.cache.get(k);
      if (local) {
        dirtyRecords.set(k, local);
      }
    }

    const snapshot = await this.parseFromFileStore();
    const merged = new Map<string, PersistedInboxStateRecord>();

    if (snapshot.available) {
      for (const remote of snapshot.records) {
        merged.set(this.key(remote.providerId, remote.externalId), remote);
      }
    } else {
      for (const [key, record] of this.cache) {
        merged.set(key, record);
      }
    }

    for (const k of removedKeys) {
      merged.delete(k);
    }

    for (const [k, local] of dirtyRecords) {
      merged.set(k, local);
    }

    const trimmed = trimByAge(Array.from(merged.values()), {
      maxEntries: MAX_TOTAL_ENTRIES,
      getTimestamp: record => record.createdAt,
      getKey: record => this.key(record.providerId, record.externalId),
    });
    await this.fileStore.write(trimmed);

    for (const [k, record] of dirtyRecords) {
      if (this.cache.get(k) === record) {
        this.dirtyKeys.delete(k);
      }
    }
    for (const k of removedKeys) {
      if (!this.cache.has(k)) {
        this.removedKeys.delete(k);
      }
    }

    const remainingDirty = new Map<string, PersistedInboxStateRecord>();
    for (const k of this.dirtyKeys) {
      const local = this.cache.get(k);
      if (local) {
        remainingDirty.set(k, local);
      }
    }
    const remainingRemoved = new Set(this.removedKeys);

    this.cache.clear();
    for (const record of trimmed) {
      this.cache.set(this.key(record.providerId, record.externalId), record);
    }
    for (const k of remainingRemoved) {
      this.cache.delete(k);
    }
    for (const [k, record] of remainingDirty) {
      this.cache.set(k, record);
    }
    this._onDidPersist.fire();
  }

  /** Parse and validate inbox state records from the backing JSON file. */
  private async parseFromFileStore(): Promise<InboxStateSnapshot> {
    const parsed = await this.fileStore.read();
    if (parsed === undefined) { return { records: [], available: false }; }
    if (!Array.isArray(parsed)) {
      logger.warn('Inbox state snapshot is not an array; falling back to the in-memory snapshot');
      return { records: [], available: false };
    }
    const records: PersistedInboxStateRecord[] = [];
    let invalidCount = 0;
    for (let i = 0; i < parsed.length; i++) {
      const error = validateInboxStateRecord(parsed[i], i);
      if (error) {
        invalidCount++;
        logger.warn(`Skipping invalid inbox state record: ${error}`);
        continue;
      }
      const record = parsed[i] as InboxStateRecord & { createdAt?: number };
      records.push({
        ...record,
        createdAt: record.createdAt ?? i,
      });
    }

    const available = invalidCount === 0;
    const deduped = new Map<string, PersistedInboxStateRecord>();
    for (const record of records) {
      const key = this.key(record.providerId, record.externalId);
      const existing = deduped.get(key);
      if (!existing || record.createdAt >= existing.createdAt) {
        deduped.set(key, record);
      }
    }

    return { records: Array.from(deduped.values()), available };
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
    const nextVersion = version ?? previousValue?.version;
    const nextResurfaceVersion = previousValue?.resurfaceVersion;
    if (
      previousValue
      && previousValue.inboxState === state
      && previousValue.version === nextVersion
      && previousValue.resurfaceVersion === nextResurfaceVersion
    ) {
      return;
    }
    const newRecord: PersistedInboxStateRecord = {
      providerId,
      externalId,
      inboxState: state,
      createdAt: Date.now(),
    };
    if (nextVersion !== undefined) {
      newRecord.version = nextVersion;
    }
    if (nextResurfaceVersion !== undefined) {
      newRecord.resurfaceVersion = nextResurfaceVersion;
    }
    this.cache.set(k, newRecord);
    this.dirtyKeys.add(k);
    this.removedKeys.delete(k);
    await this.schedulePersist();
    this._onDidChange.fire();
  }

  /**
   * Sets the inbox state for multiple discovered items in a single write.
   */
  async setStates(items: Array<{ providerId: string; externalId: string; state: InboxState; version?: string; resurfaceVersion?: string }>): Promise<void> {
    if (!this.loaded) { await this.load(); }
    if (items.length === 0) { return; }
    let changed = false;
    for (const item of items) {
      const k = this.key(item.providerId, item.externalId);
      const previousRecord = this.cache.get(k);
      const nextVersion = item.version ?? previousRecord?.version;
      const nextResurfaceVersion = item.resurfaceVersion ?? previousRecord?.resurfaceVersion;
      if (
        previousRecord
        && previousRecord.inboxState === item.state
        && previousRecord.version === nextVersion
        && previousRecord.resurfaceVersion === nextResurfaceVersion
      ) {
        continue;
      }
      const newRecord: PersistedInboxStateRecord = {
        providerId: item.providerId,
        externalId: item.externalId,
        inboxState: item.state,
        createdAt: Date.now(),
      };
      if (nextVersion !== undefined) {
        newRecord.version = nextVersion;
      }
      if (nextResurfaceVersion !== undefined) {
        newRecord.resurfaceVersion = nextResurfaceVersion;
      }
      this.cache.set(k, newRecord);
      this.dirtyKeys.add(k);
      this.removedKeys.delete(k);
      changed = true;
    }
    if (!changed) { return; }
    await this.schedulePersist();
    this._onDidChange.fire();
  }

  /**
   * Returns all persisted state records, loading from disk on first call.
   */
  async loadAll(): Promise<InboxStateRecord[]> {
    await this.load();
    return Array.from(this.cache.values(), record => toInboxStateRecord(record));
  }

  /**
   * Loads state records from disk into the cache. No-ops if already loaded.
   */
  async load(): Promise<void> {
    if (this.loaded) { return; }
    this.cache.clear();
    const snapshot = await this.parseFromFileStore();
    const records = snapshot.records;
    const trimmedRecords = trimByAge(records, {
      maxEntries: MAX_TOTAL_ENTRIES,
      getTimestamp: record => record.createdAt,
      getKey: record => this.key(record.providerId, record.externalId),
    });
    if (trimmedRecords.length !== records.length) {
      try {
        await this.fileStore.write(trimmedRecords);
        logger.info(`Trimmed inbox-state.json from ${records.length} to ${trimmedRecords.length} entries while loading to enforce the ${MAX_TOTAL_ENTRIES}-entry cap`);
      } catch (err) {
        logger.warn(`Failed to persist trimmed inbox state while loading; continuing with ${trimmedRecords.length} in-memory entries`, err);
      }
    }
    for (const record of trimmedRecords) {
      this.cache.set(this.key(record.providerId, record.externalId), record);
    }
    this.dirtyKeys.clear();
    this.removedKeys.clear();
    if (trimmedRecords.length > 0) {
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

    if (activeProviderIds.size === 0) {
      await this.flush();
      return 0;
    }

    const staleKeys: string[] = [];
    for (const [k, record] of this.cache) {
      if (activeProviderIds.has(record.providerId) && !activeKeys.has(k)) {
        staleKeys.push(k);
      }
    }

    if (staleKeys.length === 0) {
      await this.flush();
      return 0;
    }

    for (const k of staleKeys) {
      this.cache.delete(k);
      this.removedKeys.add(k);
      this.dirtyKeys.delete(k);
    }

    await this.flush();
    this._onDidChange.fire();
    return staleKeys.length;
  }

  /** Flushes pending persistence and disposes the change event emitter. */
  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.flush();
    } catch (err) {
      logger.error('Failed to flush inbox state during dispose', err);
    } finally {
      this._onDidChange.dispose();
      this._onDidPersist.dispose();
    }
  }

  /**
   * Invalidates the in-memory cache so the next mutation re-reads from disk.
   * Used for cross-window change propagation.
   */
  async invalidateCache(): Promise<void> {
    if (this.hasPendingPersist()) {
      await this.flush();
    }
    this.cache.clear();
    this.dirtyKeys.clear();
    this.removedKeys.clear();
    this.loaded = false;
  }
}

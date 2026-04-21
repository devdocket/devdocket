import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../services/logger';
import { SerializedJsonStore } from './serializedJsonStore';
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
 * provider-discovered items as a JSON file on disk.
 *
 * Only the state enum is stored — item data (title, description, url) is
 * always read live from the provider. All writes are serialized through an
 * internal queue to prevent concurrent file corruption.
 */
export class DiscoveredStateStore extends SerializedJsonStore {
  private readonly filePath: string;
  private readonly cache = new Map<string, DiscoveredStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  /**
   * @param storagePath - Directory where `discovered-state.json` will be stored.
   */
  constructor(storagePath: string) {
    super();
    this.filePath = path.join(storagePath, 'discovered-state.json');
  }

  private key(providerId: string, externalId: string): string {
    return `${providerId}::${externalId}`;
  }

  /**
   * Returns the current inbox state for a discovered item, or `undefined` if unknown.
   * @param providerId - The provider that discovered the item.
   * @param externalId - The provider-scoped item identifier.
   */
  getState(providerId: string, externalId: string): InboxState | undefined {
    return this.cache.get(this.key(providerId, externalId))?.inboxState;
  }

  /**
   * Returns the stored version for a discovered item, or `undefined` if not set.
   * @param providerId - The provider that discovered the item.
   * @param externalId - The provider-scoped item identifier.
   */
  getVersion(providerId: string, externalId: string): string | undefined {
    return this.cache.get(this.key(providerId, externalId))?.version;
  }

  /**
   * Returns the stored resurface version for a discovered item, or `undefined` if not set.
   * @param providerId - The provider that discovered the item.
   * @param externalId - The provider-scoped item identifier.
   */
  getResurfaceVersion(providerId: string, externalId: string): string | undefined {
    return this.cache.get(this.key(providerId, externalId))?.resurfaceVersion;
  }

  /**
   * Sets the inbox state for a single discovered item and persists to disk.
   * @param providerId - The provider that discovered the item.
   * @param externalId - The provider-scoped item identifier.
   * @param state      - The new inbox state.
   * @param version    - Optional version identifier for resurfacing detection.
   *
   * Note: `resurfaceVersion` is only settable via `setStates()`, not here.
   * This method preserves any existing `resurfaceVersion` from the previous record.
   * This is intentional: `setState()` is used by UI commands (accept/dismiss)
   * which should not alter version tracking.
   *
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async setState(providerId: string, externalId: string, state: InboxState, version?: string): Promise<void> {
    logger.debug(`Setting state for ${providerId}/${externalId} to ${state}`);
    await this.enqueue(async () => {
      if (!this.loaded) {
        await this.load();
      }
      const k = this.key(providerId, externalId);
      const previousValue = this.cache.get(k);
      const newRecord: DiscoveredStateRecord = { providerId, externalId, inboxState: state };
      if (version !== undefined) {
        newRecord.version = version;
      } else if (previousValue?.version !== undefined) {
        // Preserve existing version when caller doesn't supply one
        newRecord.version = previousValue.version;
      }
      if (previousValue?.resurfaceVersion !== undefined) {
        newRecord.resurfaceVersion = previousValue.resurfaceVersion;
      }
      this.cache.set(k, newRecord);
      try {
        await this.writeJson(this.filePath, Array.from(this.cache.values()));
      } catch (err) {
        if (previousValue) {
          this.cache.set(k, previousValue);
        } else {
          this.cache.delete(k);
        }
        throw err;
      }
    });
    this._onDidChange.fire();
  }

  /**
   * Sets the inbox state for multiple discovered items in a single serialized write.
   * @param items - Array of items with their new states and optional versions.
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async setStates(items: Array<{ providerId: string; externalId: string; state: InboxState; version?: string; resurfaceVersion?: string }>): Promise<void> {
    await this.enqueue(async () => {
      if (!this.loaded) {
        await this.load();
      }
      const rollback = new Map<string, DiscoveredStateRecord | undefined>();
      for (const item of items) {
        const k = this.key(item.providerId, item.externalId);
        rollback.set(k, this.cache.get(k));
        const previousRecord = this.cache.get(k);
        const newRecord: DiscoveredStateRecord = { providerId: item.providerId, externalId: item.externalId, inboxState: item.state };
        if (item.version !== undefined) {
          newRecord.version = item.version;
        } else if (previousRecord?.version !== undefined) {
          // Preserve existing version when caller doesn't supply one
          newRecord.version = previousRecord.version;
        }
        if (item.resurfaceVersion !== undefined) {
          newRecord.resurfaceVersion = item.resurfaceVersion;
        } else if (previousRecord?.resurfaceVersion !== undefined) {
          newRecord.resurfaceVersion = previousRecord.resurfaceVersion;
        }
        this.cache.set(k, newRecord);
      }
      try {
        await this.writeJson(this.filePath, Array.from(this.cache.values()));
      } catch (err) {
        for (const [k, previousValue] of rollback) {
          if (previousValue) {
            this.cache.set(k, previousValue);
          } else {
            this.cache.delete(k);
          }
        }
        throw err;
      }
    });
    this._onDidChange.fire();
  }

  /**
   * Returns all persisted state records, loading from disk on first call.
   * @returns All discovered-state records.
   */
  async loadAll(): Promise<DiscoveredStateRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  /**
   * Loads state records from disk into the cache. No-ops if already loaded.
   * @throws If the file exists but cannot be parsed.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    // Guard against concurrent loads: reuse the same in-flight promise
    if (this.loadPromise === null) {
      this.loadPromise = this.doLoad().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const parsed = await this.readJson(this.filePath);
      if (parsed === undefined) {
        this.cache.clear();
        this.loaded = true;
        return;
      }
      if (!Array.isArray(parsed)) {
        logger.warn('Discovered state file does not contain an array — backing up and resetting to empty');
        await this.backupFile(this.filePath);
        this.cache.clear();
        this.loaded = true;
        return;
      }
      this.cache.clear();
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
      this.loaded = true;
    } finally {
      // Clear the in-flight promise so it doesn't retain a reference
      // and so reload can be supported in the future
      this.loadPromise = null;
    }
  }

  /** Disposes the change event emitter. */
  dispose(): void {
    this._onDidChange.dispose();
  }
}

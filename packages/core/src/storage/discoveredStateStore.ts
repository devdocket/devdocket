import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';

/** Possible states for a provider-discovered item in the inbox workflow. */
export type InboxState = 'unseen' | 'accepted' | 'dismissed';

/** Persisted mapping of a provider item to its inbox state. */
export interface DiscoveredStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;
}

/**
 * Persists inbox-state records (`unseen | accepted | dismissed`) for
 * provider-discovered items as a JSON file on disk.
 *
 * Only the state enum is stored — item data (title, description, url) is
 * always read live from the provider. All writes are serialized through an
 * internal queue to prevent concurrent file corruption.
 */
export class DiscoveredStateStore {
  private readonly filePath: string;
  private readonly cache = new Map<string, DiscoveredStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private writeQueue: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  /**
   * @param storagePath - Directory where `discovered-state.json` will be stored.
   */
  constructor(storagePath: string) {
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
   * Sets the inbox state for a single discovered item and persists to disk.
   * @param providerId - The provider that discovered the item.
   * @param externalId - The provider-scoped item identifier.
   * @param state      - The new inbox state.
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async setState(providerId: string, externalId: string, state: InboxState): Promise<void> {
    logger.debug(`Setting state for ${providerId}/${externalId} to ${state}`);
    await this.enqueue(async () => {
      if (!this.loaded) {
        await this.load();
      }
      const k = this.key(providerId, externalId);
      const previousValue = this.cache.get(k);
      const newRecord = { providerId, externalId, inboxState: state };
      this.cache.set(k, newRecord);
      try {
        await this.writeFile();
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
   * @param items - Array of items with their new states.
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async setStates(items: Array<{ providerId: string; externalId: string; state: InboxState }>): Promise<void> {
    await this.enqueue(async () => {
      if (!this.loaded) {
        await this.load();
      }
      const rollback = new Map<string, DiscoveredStateRecord | undefined>();
      for (const item of items) {
        const k = this.key(item.providerId, item.externalId);
        rollback.set(k, this.cache.get(k));
        this.cache.set(k, { providerId: item.providerId, externalId: item.externalId, inboxState: item.state });
      }
      try {
        await this.writeFile();
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
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const records = JSON.parse(data) as DiscoveredStateRecord[];
      this.cache.clear();
      for (const record of records) {
        this.cache.set(this.key(record.providerId, record.externalId), record);
      }
      logger.debug(`Loaded discovered state: ${this.cache.size} entries`);
      this.loaded = true;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.cache.clear();
        this.loaded = true;
        return;
      }
      throw err;
    }
  }

  private async writeFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const records = Array.from(this.cache.values());
    const data = JSON.stringify(records, null, 2);
    await fs.writeFile(this.filePath, data, 'utf-8');
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(op, op);
    return this.writeQueue;
  }

  /** Disposes the change event emitter. */
  dispose(): void {
    this._onDidChange.dispose();
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

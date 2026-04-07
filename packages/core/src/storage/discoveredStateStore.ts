import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';

export type InboxState = 'unseen' | 'accepted' | 'dismissed';

export interface DiscoveredStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;
}

export class DiscoveredStateStore {
  private readonly filePath: string;
  private readonly cache = new Map<string, DiscoveredStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private writeQueue: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'discovered-state.json');
  }

  private key(providerId: string, externalId: string): string {
    return `${providerId}::${externalId}`;
  }

  getState(providerId: string, externalId: string): InboxState | undefined {
    return this.cache.get(this.key(providerId, externalId))?.inboxState;
  }

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
      } catch (err: unknown) {
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
      } catch (err: unknown) {
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

  async loadAll(): Promise<DiscoveredStateRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

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

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';

const inboxStates = ['unseen', 'accepted', 'dismissed'] as const;

export type InboxState = (typeof inboxStates)[number];

const validInboxStates = new Set<string>(inboxStates);

export interface DiscoveredStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;
}

/**
 * Validates that a parsed JSON value has the required shape of a DiscoveredStateRecord.
 * Returns a descriptive error string if invalid, or undefined if valid.
 */
function validateDiscoveredStateRecord(value: unknown, index: number): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return `Record at index ${index} is not an object`;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.providerId !== 'string' || obj.providerId.length === 0) {
    return `Record at index ${index} is missing a valid "providerId" (string)`;
  }
  if (typeof obj.externalId !== 'string' || obj.externalId.length === 0) {
    return `Record at index ${index} is missing a valid "externalId" (string)`;
  }
  if (typeof obj.inboxState !== 'string' || !validInboxStates.has(obj.inboxState)) {
    return `Record at index ${index} has invalid "inboxState": ${JSON.stringify(obj.inboxState)}`;
  }
  return undefined;
}

export class DiscoveredStateStore {
  private readonly filePath: string;
  private readonly cache = new Map<string, DiscoveredStateRecord>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private writeQueue: Promise<void> = Promise.resolve();
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
    if (!this.loaded) {
      await this.load();
    }
    const k = this.key(providerId, externalId);
    const newRecord = { providerId, externalId, inboxState: state };
    await this.enqueue(() => {
      const previousValue = this.cache.get(k);
      this.cache.set(k, newRecord);
      return this.writeFile().catch((err) => {
        if (previousValue) {
          this.cache.set(k, previousValue);
        } else {
          this.cache.delete(k);
        }
        throw err;
      });
    });
    this._onDidChange.fire();
  }

  async setStates(items: Array<{ providerId: string; externalId: string; state: InboxState }>): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
    await this.enqueue(() => {
      const rollback = new Map<string, DiscoveredStateRecord | undefined>();
      for (const item of items) {
        const k = this.key(item.providerId, item.externalId);
        rollback.set(k, this.cache.get(k));
        this.cache.set(k, { providerId: item.providerId, externalId: item.externalId, inboxState: item.state });
      }
      return this.writeFile().catch((err) => {
        for (const [k, previousValue] of rollback) {
          if (previousValue) {
            this.cache.set(k, previousValue);
          } else {
            this.cache.delete(k);
          }
        }
        throw err;
      });
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
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        logger.warn('Failed to parse discovered state file — backing up and resetting to empty');
        await this.backupCorruptedFile();
        this.cache.clear();
        this.loaded = true;
        return;
      }
      if (!Array.isArray(parsed)) {
        logger.warn('Discovered state file does not contain an array — resetting to empty');
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

  private async backupCorruptedFile(): Promise<void> {
    try {
      const backupPath = `${this.filePath}.corrupt.${Date.now()}`;
      await fs.rename(this.filePath, backupPath);
      logger.warn(`Backed up corrupted file to ${backupPath}`);
    } catch {
      logger.warn('Failed to back up corrupted discovered state file');
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

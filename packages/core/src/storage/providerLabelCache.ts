import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../services/logger';
import { MAX_STORE_FILE_SIZE } from './limits';

/**
 * Persists a mapping of providerId → display label so that tree views
 * can show human-friendly group names immediately on startup, before
 * provider extensions have registered.
 */
export class ProviderLabelCache {
  private labels = new Map<string, string>();
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'provider-labels.json');
  }

  /** Load cached labels from disk. Safe to call even if the file does not exist. */
  async load(): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(this.filePath);
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') {
        this.labels.clear();
        return;
      }
      logger.warn(`Failed to stat provider label cache at ${this.filePath}:`, error);
      throw error;
    }

    if (!stats.isFile()) {
      logger.warn(`Provider label cache path is not a regular file: ${this.filePath} — removing`);
      try {
        await fs.promises.rm(this.filePath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      this.labels.clear();
      return;
    }

    if (stats.size > MAX_STORE_FILE_SIZE) {
      logger.warn(`Provider label cache exceeds ${MAX_STORE_FILE_SIZE} bytes — resetting to empty`);
      this.labels.clear();
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') {
        this.labels.clear();
        return;
      }
      logger.warn(`Failed to read provider label cache from ${this.filePath}:`, error);
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      logger.warn('Failed to parse provider label cache — backing up and resetting to empty');
      await this.backupInvalidFile();
      this.labels.clear();
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      logger.warn('Provider label cache does not contain a valid object — backing up and resetting to empty');
      await this.backupInvalidFile();
      this.labels.clear();
      return;
    }

    const nextLabels = new Map<string, string>();
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        logger.warn('Provider label cache contains non-string values — backing up and resetting to empty');
        await this.backupInvalidFile();
        this.labels.clear();
        return;
      }
      nextLabels.set(key, value);
    }

    this.labels.clear();
    for (const [key, value] of nextLabels) {
      this.labels.set(key, value);
    }
  }

  /** Get a cached label for a provider, or undefined if not cached. */
  get(providerId: string): string | undefined {
    return this.labels.get(providerId);
  }

  /** Update the cached label for a provider and persist to disk. */
  async set(providerId: string, label: string): Promise<void> {
    if (this.labels.get(providerId) === label) {
      await this.writeQueue; // Ensure any in-flight writes have settled
      return;
    }
    const hadPrevious = this.labels.has(providerId);
    const previousLabel = this.labels.get(providerId);
    this.labels.set(providerId, label);
    await this.enqueue(async () => {
      try {
        await this.save();
      } catch (error) {
        // Roll back in-memory state so future set() calls retry persistence
        if (this.labels.get(providerId) === label) {
          if (hadPrevious && previousLabel !== undefined) {
            this.labels.set(providerId, previousLabel);
          } else {
            this.labels.delete(providerId);
          }
        }
        throw error;
      }
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(op, error => {
      logger.warn('Previous provider label cache write failed; continuing with next queued write.', error);
      return op();
    });
    return this.writeQueue;
  }

  private async save(): Promise<void> {
    const obj = Object.create(null) as Record<string, string>;
    for (const [key, value] of this.labels) {
      obj[key] = value;
    }
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  private async backupInvalidFile(): Promise<void> {
    try {
      const backupPath = `${this.filePath}.corrupt.${Date.now()}`;
      await fs.promises.rename(this.filePath, backupPath);
      logger.warn(`Backed up invalid provider label cache to ${backupPath}`);
    } catch {
      // Best-effort backup
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../services/logger';

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
      this.labels.clear();
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      this.labels.clear();
      return;
    }

    const nextLabels = new Map<string, string>();
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value !== 'string') {
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
      return; // No change
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
    this.writeQueue = this.writeQueue.then(op, () => op());
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
}

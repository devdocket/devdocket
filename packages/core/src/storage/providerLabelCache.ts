import * as path from 'path';
import { logger } from '../services/logger';
import { SerializedJsonStore } from './serializedJsonStore';

/**
 * Persists a mapping of providerId → display label so that tree views
 * can show human-friendly group names immediately on startup, before
 * provider extensions have registered.
 */
export class ProviderLabelCache extends SerializedJsonStore {
  private labels = new Map<string, string>();
  private readonly filePath: string;

  constructor(storagePath: string) {
    super();
    this.filePath = path.join(storagePath, 'provider-labels.json');
  }

  /** Load cached labels from disk. Safe to call even if the file does not exist. */
  async load(): Promise<void> {
    const parsed = await this.readJson(this.filePath);
    if (parsed === undefined) {
      this.labels.clear();
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn('Provider label cache does not contain a valid object — backing up and resetting to empty');
      await this.backupFile(this.filePath);
      this.labels.clear();
      return;
    }

    const nextLabels = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        logger.warn('Provider label cache contains non-string values — backing up and resetting to empty');
        await this.backupFile(this.filePath);
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
      await this.flush(); // Ensure any in-flight writes have settled
      return;
    }
    const hadPrevious = this.labels.has(providerId);
    const previousLabel = this.labels.get(providerId);
    this.labels.set(providerId, label);
    await this.enqueue(async () => {
      try {
        const obj = Object.create(null) as Record<string, string>;
        for (const [key, value] of this.labels) {
          obj[key] = value;
        }
        await this.writeJson(this.filePath, obj);
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
}

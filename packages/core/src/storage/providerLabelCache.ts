import * as fs from 'fs';
import * as path from 'path';

/**
 * Persists a mapping of providerId → display label so that tree views
 * can show human-friendly group names immediately on startup, before
 * provider extensions have registered.
 */
export class ProviderLabelCache {
  private labels = new Map<string, string>();
  private readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'provider-labels.json');
  }

  /** Load cached labels from disk. Safe to call even if the file does not exist. */
  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        this.labels.clear();
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (typeof key === 'string' && typeof value === 'string') {
            this.labels.set(key, value);
          }
        }
      }
    } catch {
      // File doesn't exist yet or is corrupted — start with empty cache
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
    this.labels.set(providerId, label);
    await this.save();
  }

  private async save(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [key, value] of this.labels) {
      obj[key] = value;
    }
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
  }
}

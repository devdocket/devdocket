import type { Memento } from 'vscode';

const STORAGE_KEY = 'devdocket.provider-labels';

/**
 * Persists a mapping of providerId → display label so that tree views
 * can show human-friendly group names immediately on startup, before
 * provider extensions have registered.
 */
export class ProviderLabelCache {
  private readonly globalState: Memento;
  private labels = new Map<string, string>();

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  /** Load cached labels from globalState. */
  async load(): Promise<void> {
    const parsed = this.globalState.get<Record<string, unknown>>(STORAGE_KEY);
    this.labels.clear();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          this.labels.set(key, value);
        }
      }
    }
  }

  /** Get a cached label for a provider, or undefined if not cached. */
  get(providerId: string): string | undefined {
    return this.labels.get(providerId);
  }

  /** Update the cached label for a provider and persist to globalState. */
  async set(providerId: string, label: string): Promise<void> {
    if (this.labels.get(providerId) === label) { return; }
    this.labels.set(providerId, label);
    const obj = Object.create(null) as Record<string, string>;
    for (const [key, value] of this.labels) {
      obj[key] = value;
    }
    await this.globalState.update(STORAGE_KEY, obj);
  }
}

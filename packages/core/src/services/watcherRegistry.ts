import * as vscode from 'vscode';
import type { DevDocketRunWatcher } from '@devdocket/shared';

/**
 * Registry for DevDocketRunWatcher instances.
 * Manages registration, lookup, and lifecycle of run watchers.
 */
export class WatcherRegistry {
  private watchers = new Map<string, DevDocketRunWatcher>();

  constructor(private logger: { info: (msg: string) => void; warn: (msg: string) => void }) {}

  /**
   * Register a run watcher.
   * @param watcher - The watcher to register
   * @returns Disposable that unregisters the watcher when disposed
   * @throws If a watcher with the same ID is already registered
   */
  register(watcher: DevDocketRunWatcher): vscode.Disposable {
    if (this.watchers.has(watcher.id)) {
      const msg = `Run watcher with id '${watcher.id}' is already registered`;
      this.logger.warn(msg);
      throw new Error(msg);
    }
    this.watchers.set(watcher.id, watcher);
    this.logger.info(`Registered run watcher: ${watcher.id} (${watcher.label})`);
    
    return new vscode.Disposable(() => {
      this.watchers.delete(watcher.id);
      this.logger.info(`Unregistered run watcher: ${watcher.id}`);
    });
  }

  /**
   * Get a watcher by ID.
   */
  get(id: string): DevDocketRunWatcher | undefined {
    return this.watchers.get(id);
  }

  /**
   * Find a watcher that can handle the given URL.
   * @returns The first watcher that returns true from canWatch, or undefined
   */
  findWatcherForUrl(url: string): DevDocketRunWatcher | undefined {
    for (const watcher of this.watchers.values()) {
      try {
        if (watcher.canWatch(url)) {
          return watcher;
        }
      } catch (err) {
        this.logger.warn(`Watcher ${watcher.id} threw error in canWatch: ${err}`);
      }
    }
    return undefined;
  }

  /**
   * Get all registered watchers.
   */
  getAll(): DevDocketRunWatcher[] {
    return Array.from(this.watchers.values());
  }

  dispose(): void {
    this.watchers.clear();
  }
}

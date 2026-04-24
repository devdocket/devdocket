import * as vscode from 'vscode';
import type { DevDocketPRWatcher } from '@devdocket/shared';

/**
 * Registry for DevDocketPRWatcher instances.
 * Manages registration, lookup, and lifecycle of PR watchers.
 */
export class PRWatcherRegistry {
  private watchers = new Map<string, DevDocketPRWatcher>();

  constructor(private logger: { info: (msg: string) => void; warn: (msg: string) => void }) {}

  /**
   * Register a PR watcher.
   * @param watcher - The watcher to register
   * @returns Disposable that unregisters the watcher when disposed
   * @throws If a watcher with the same ID is already registered
   */
  register(watcher: DevDocketPRWatcher): vscode.Disposable {
    if (this.watchers.has(watcher.id)) {
      const msg = `PR watcher with id '${watcher.id}' is already registered`;
      this.logger.warn(msg);
      throw new Error(msg);
    }
    this.watchers.set(watcher.id, watcher);
    this.logger.info(`Registered PR watcher: ${watcher.id} (${watcher.label})`);

    return new vscode.Disposable(() => {
      if (this.watchers.get(watcher.id) === watcher) {
        this.watchers.delete(watcher.id);
        this.logger.info(`Unregistered PR watcher: ${watcher.id}`);
      }
    });
  }

  /**
   * Get a watcher by ID.
   */
  get(id: string): DevDocketPRWatcher | undefined {
    return this.watchers.get(id);
  }

  /**
   * Find a watcher that can handle the given URL.
   * @returns The first watcher that returns true from canWatch, or undefined
   */
  findWatcherForUrl(url: string): DevDocketPRWatcher | undefined {
    for (const watcher of this.watchers.values()) {
      try {
        if (watcher.canWatch(url)) {
          return watcher;
        }
      } catch (err) {
        this.logger.warn(`PR watcher ${watcher.id} threw error in canWatch: ${err}`);
      }
    }
    return undefined;
  }

  /**
   * Get all registered watchers.
   */
  getAll(): DevDocketPRWatcher[] {
    return Array.from(this.watchers.values());
  }

  dispose(): void {
    this.watchers.clear();
  }
}

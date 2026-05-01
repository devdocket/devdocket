import * as vscode from 'vscode';
import { DevDocketAction } from '../api/types';
import { WorkItem } from '../models/workItem';
import { logger } from './logger';
import { Registry } from './registry';

/**
 * Central registry for {@link DevDocketAction} instances.
 *
 * Actions are contributed by provider extensions and appear as contextual
 * commands on work items whose {@link DevDocketAction.canRun} predicate
 * returns `true`.
 */
export class ActionRegistry {
  private readonly registry = new Registry<DevDocketAction>('Action');
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeRegistrations: vscode.Event<void> = this._onDidChange.event;

  /**
   * Register an action and make it available in work-item context menus.
   *
   * @param action - The action to register.
   * @returns A {@link vscode.Disposable} that unregisters the action when disposed.
   * @throws If an action with the same {@link DevDocketAction.id} is already registered.
   */
  register(action: DevDocketAction): vscode.Disposable {
    const registration = this.registry.register(action);
    this._onDidChange.fire();

    let disposed = false;
    return new vscode.Disposable(() => {
      if (disposed) {
        return;
      }
      disposed = true;

      const wasRegistered = this.registry.get(action.id) === action;
      registration.dispose();
      if (wasRegistered) {
        this._onDidChange.fire();
      }
    });
  }

  /**
   * Find all actions applicable to a given work item.
   *
   * Each registered action's {@link DevDocketAction.canRun} is evaluated
   * and only matching actions are returned.
   *
   * @param item - The work item to match actions against.
   * @returns An array of actions that can be run on the item.
   */
  getActionsFor(item: WorkItem): DevDocketAction[] {
    const matching = this.registry.getAll().filter((a) => a.canRun(item));
    logger.debug(`Found ${matching.length} actions for item ${item.id}`);
    return matching;
  }

  /**
   * Determine whether any registered action can run for a given work item.
   *
   * This is intended for rendering paths that only need a yes/no answer and
   * must not allow third-party action predicates to break the UI.
   *
   * @param item - The work item to match actions against.
   * @returns `true` when at least one action can run for the item.
   */
  hasActionsFor(item: WorkItem): boolean {
    try {
      return this.registry.getAll().some((action) => {
        try {
          return action.canRun(item);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  /**
   * Look up a registered action by its unique identifier.
   *
   * @param id - The action identifier to search for.
   * @returns The matching action, or `undefined` if not registered.
   */
  getAction(id: string): DevDocketAction | undefined {
    return this.registry.get(id);
  }

  /** Release all registered actions. */
  dispose(): void {
    const hadActions = this.registry.size > 0;
    this.registry.clear();
    if (hadActions) {
      this._onDidChange.fire();
    }
    this._onDidChange.dispose();
  }
}

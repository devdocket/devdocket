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

  /**
   * Register an action and make it available in work-item context menus.
   *
   * @param action - The action to register.
   * @returns A {@link vscode.Disposable} that unregisters the action when disposed.
   * @throws If an action with the same {@link DevDocketAction.id} is already registered.
   */
  register(action: DevDocketAction): vscode.Disposable {
    return this.registry.register(action);
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
    this.registry.clear();
  }
}

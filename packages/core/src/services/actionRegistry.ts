import * as vscode from 'vscode';
import { WorkCenterAction } from '../api/types';
import { WorkItem } from '../models/workItem';
import { logger } from './logger';

/**
 * Central registry for {@link WorkCenterAction} instances.
 *
 * Actions are contributed by provider extensions and appear as contextual
 * commands on work items whose {@link WorkCenterAction.canRun} predicate
 * returns `true`.
 */
export class ActionRegistry {
  private readonly actions = new Map<string, WorkCenterAction>();

  /**
   * Register an action and make it available in work-item context menus.
   *
   * @param action - The action to register.
   * @returns A {@link vscode.Disposable} that unregisters the action when disposed.
   * @throws If an action with the same {@link WorkCenterAction.id} is already registered.
   */
  register(action: WorkCenterAction): vscode.Disposable {
    if (this.actions.has(action.id)) {
      throw new Error(`Action already registered: ${action.id}`);
    }
    this.actions.set(action.id, action);
    logger.info(`Registered action: ${action.id} (${action.label})`);

    return new vscode.Disposable(() => {
      this.actions.delete(action.id);
    });
  }

  /**
   * Find all actions applicable to a given work item.
   *
   * Each registered action's {@link WorkCenterAction.canRun} is evaluated
   * and only matching actions are returned.
   *
   * @param item - The work item to match actions against.
   * @returns An array of actions that can be run on the item.
   */
  getActionsFor(item: WorkItem): WorkCenterAction[] {
    const matching = Array.from(this.actions.values()).filter((a) => a.canRun(item));
    logger.debug(`Found ${matching.length} actions for item ${item.id}`);
    return matching;
  }

  /**
   * Look up a registered action by its unique identifier.
   *
   * @param id - The action identifier to search for.
   * @returns The matching action, or `undefined` if not registered.
   */
  getAction(id: string): WorkCenterAction | undefined {
    return this.actions.get(id);
  }

  /** Release all registered actions. */
  dispose(): void {
    this.actions.clear();
  }
}

import * as vscode from 'vscode';
import { WorkCenterAction } from '../api/types';
import { WorkItem } from '../models/workItem';
import { logger } from './logger';

export class ActionRegistry {
  private readonly actions = new Map<string, WorkCenterAction>();

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

  getActionsFor(item: WorkItem): WorkCenterAction[] {
    const matching = Array.from(this.actions.values()).filter((a) => a.canRun(item));
    logger.debug(`Found ${matching.length} actions for item ${item.id}`);
    return matching;
  }

  getAction(id: string): WorkCenterAction | undefined {
    return this.actions.get(id);
  }

  dispose(): void {
    this.actions.clear();
  }
}

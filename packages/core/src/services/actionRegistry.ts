import * as vscode from 'vscode';
import { WorkCenterAction } from '../api/types';
import { WorkItem } from '../models/workItem';
import { logger } from './logger';
import { Registry } from './registry';

export class ActionRegistry {
  private readonly registry = new Registry<WorkCenterAction>('Action');

  register(action: WorkCenterAction): vscode.Disposable {
    return this.registry.register(action);
  }

  getActionsFor(item: WorkItem): WorkCenterAction[] {
    const matching = this.registry.getAll().filter((a) => a.canRun(item));
    logger.debug(`Found ${matching.length} actions for item ${item.id}`);
    return matching;
  }

  getAction(id: string): WorkCenterAction | undefined {
    return this.registry.get(id);
  }

  dispose(): void {
    this.registry.clear();
  }
}

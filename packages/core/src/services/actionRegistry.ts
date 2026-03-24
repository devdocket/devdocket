import * as vscode from 'vscode';
import { WorkCenterAction } from '../api/types';
import { WorkItem } from '../models/workItem';

export class ActionRegistry {
  private readonly actions = new Map<string, WorkCenterAction>();

  register(action: WorkCenterAction): vscode.Disposable {
    if (this.actions.has(action.id)) {
      throw new Error(`Action already registered: ${action.id}`);
    }
    this.actions.set(action.id, action);

    return new vscode.Disposable(() => {
      this.actions.delete(action.id);
    });
  }

  getActionsFor(item: WorkItem): WorkCenterAction[] {
    return Array.from(this.actions.values()).filter((a) => a.canRun(item));
  }

  getAction(id: string): WorkCenterAction | undefined {
    return this.actions.get(id);
  }

  dispose(): void {
    this.actions.clear();
  }
}

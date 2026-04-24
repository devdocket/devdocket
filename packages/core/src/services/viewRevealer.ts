import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from './workGraph';
import { logger } from './logger';

// WorkItem | unknown simplifies to unknown; we use the alias for readability
// at call sites — reveal() matches elements via TreeItem.id, not type identity.
type WorkItemTreeView = vscode.TreeView<unknown>;

/**
 * Reveals a work item in the appropriate destination tree view after
 * it moves between views (e.g. Queue → Focus, Inbox → Queue).
 *
 * Uses VS Code's TreeView.reveal() API to scroll to and highlight the item.
 * All reveals are best-effort — failures are logged but never surface to the user.
 */
export class ViewRevealer {
  constructor(
    private readonly workGraph: WorkGraph,
    private readonly queueTreeView: WorkItemTreeView,
    private readonly focusTreeView: WorkItemTreeView,
    private readonly historyTreeView: WorkItemTreeView,
  ) {}

  /**
   * Reveal a work item in the tree view that matches its current state.
   * Determines the destination view from the item's state after transition.
   */
  async revealByState(itemId: string): Promise<void> {
    const item = this.workGraph.getItem(itemId);
    if (!item) { return; }

    const view = this.getViewForState(item.state);
    if (!view) { return; }

    await this.doReveal(view, item);
  }

  /** Reveal an item specifically in the Queue view. */
  async revealInQueue(itemId: string): Promise<void> {
    const item = this.workGraph.getItem(itemId);
    if (!item) { return; }
    await this.doReveal(this.queueTreeView, item);
  }

  /** Reveal an item specifically in the Focus view. */
  async revealInFocus(itemId: string): Promise<void> {
    const item = this.workGraph.getItem(itemId);
    if (!item) { return; }
    await this.doReveal(this.focusTreeView, item);
  }

  private getViewForState(state: WorkItemState): WorkItemTreeView | undefined {
    switch (state) {
      case WorkItemState.New:
        return this.queueTreeView;
      case WorkItemState.InProgress:
      case WorkItemState.Paused:
        return this.focusTreeView;
      case WorkItemState.Done:
      case WorkItemState.Archived:
        return this.historyTreeView;
      default:
        return undefined;
    }
  }

  private async doReveal(view: WorkItemTreeView, item: WorkItem): Promise<void> {
    if (!view.visible) { return; }
    try {
      await view.reveal(item, { select: true, focus: false, expand: false });
    } catch (err: unknown) {
      logger.debug('Auto-reveal failed (view may not be visible)', err);
    }
  }
}

import * as vscode from 'vscode';
import type { RunState, RunConclusion } from '@devdocket/shared';
import { WatcherService, WatchedRun } from '../services/watcherService';

/**
 * Tree item for a watched run.
 */
class WatchedRunNode extends vscode.TreeItem {
  constructor(
    public readonly watchedRun: WatchedRun,
    public readonly children: JobStatusNode[]
  ) {
    const label = watchedRun.identifier.displayName;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    
    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.getIconForState(watchedRun.status.overallState, watchedRun.status.conclusion, watchedRun.hasWarning);
    this.contextValue = watchedRun.status.overallState === 'completed' ? 'watchedRun.completed' : 'watchedRun.active';
    
    this.command = {
      command: 'devdocket.openWatchUrl',
      title: 'Open in Browser',
      arguments: [watchedRun],
    };
  }

  private buildTooltip(): string {
    const run = this.watchedRun;
    const lines = [run.identifier.displayName];
    
    if (run.identifier.repo) {
      lines.push(`Repository: ${run.identifier.repo}`);
    }
    
    lines.push(`State: ${run.status.overallState}`);
    if (run.status.overallState === 'completed' && run.status.conclusion) {
      lines.push(`Conclusion: ${run.status.conclusion}`);
    }
    
    if (run.hasWarning && run.errorMessage) {
      lines.push(`Warning: ${run.errorMessage}`);
    }
    
    return lines.join('\n');
  }

  private buildDescription(): string {
    const run = this.watchedRun;
    if (run.hasWarning) {
      return 'polling failed';
    }
    if (run.status.overallState === 'completed' && run.status.conclusion) {
      return run.status.conclusion;
    }
    return run.status.overallState;
  }

  private getIconForState(state: RunState, conclusion: RunConclusion, hasWarning?: boolean): vscode.ThemeIcon {
    if (hasWarning) {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    }
    
    if (state === 'queued') {
      return new vscode.ThemeIcon('clock');
    }
    if (state === 'running') {
      return new vscode.ThemeIcon('sync~spin');
    }
    // completed
    if (conclusion === 'success') {
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    }
    if (conclusion === 'failure') {
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    }
    if (conclusion === 'cancelled') {
      return new vscode.ThemeIcon('circle-slash');
    }
    if (conclusion === 'skipped') {
      return new vscode.ThemeIcon('debug-step-over');
    }
    return new vscode.ThemeIcon('circle-outline');
  }
}

/**
 * Tree item for a job within a run.
 */
class JobStatusNode extends vscode.TreeItem {
  constructor(
    public readonly jobName: string,
    public readonly state: RunState,
    public readonly conclusion: RunConclusion
  ) {
    super(jobName, vscode.TreeItemCollapsibleState.None);
    
    this.description = this.buildDescription();
    this.iconPath = this.getIconForJobState(state, conclusion);
    this.contextValue = 'jobStatus';
  }

  private buildDescription(): string {
    if (this.state === 'completed' && this.conclusion) {
      return this.conclusion;
    }
    return this.state;
  }

  private getIconForJobState(state: RunState, conclusion: RunConclusion): vscode.ThemeIcon {
    if (state === 'queued') {
      return new vscode.ThemeIcon('circle-outline');
    }
    if (state === 'running') {
      return new vscode.ThemeIcon('loading~spin');
    }
    // completed
    if (conclusion === 'success') {
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    }
    if (conclusion === 'failure') {
      return new vscode.ThemeIcon('x', new vscode.ThemeColor('testing.iconFailed'));
    }
    if (conclusion === 'cancelled') {
      return new vscode.ThemeIcon('circle-slash');
    }
    if (conclusion === 'skipped') {
      return new vscode.ThemeIcon('debug-step-over');
    }
    return new vscode.ThemeIcon('circle-outline');
  }
}

/**
 * Tree data provider for the Watches view.
 */
export class WatchesTreeProvider implements vscode.TreeDataProvider<WatchedRunNode | JobStatusNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WatchedRunNode | JobStatusNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private watcherService: WatcherService) {
    // Listen for watch changes
    watcherService.onDidChangeWatchedRuns(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(element: WatchedRunNode | JobStatusNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WatchedRunNode | JobStatusNode): vscode.ProviderResult<(WatchedRunNode | JobStatusNode)[]> {
    if (!element) {
      // Root: return all active (non-dismissed) watches
      const watches = this.watcherService.getActiveWatches();
      return watches.map(watch => {
        const jobNodes = watch.status.jobs.map(
          job => new JobStatusNode(job.name, job.state, job.conclusion)
        );
        return new WatchedRunNode(watch, jobNodes);
      });
    }
    
    if (element instanceof WatchedRunNode) {
      // Children: job status nodes
      return element.children;
    }
    
    // Jobs have no children
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

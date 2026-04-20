import * as vscode from 'vscode';
import type { RunState, RunConclusion } from '@devdocket/shared';
import { WatcherService, WatchedRun } from '../services/watcherService';
import type { ViewLayout } from './viewLayout';

/**
 * Tree item for a watched run.
 */
class WatchedRunNode extends vscode.TreeItem {
  constructor(
    public readonly watchedRun: WatchedRun,
    public readonly children: JobStatusNode[]
  ) {
    const label = watchedRun.identifier.displayName;
    super(label, children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    
    this.id = `watch:${watchedRun.identifier.providerId}:${watchedRun.identifier.repo ?? ''}:${watchedRun.identifier.runId}`;
    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.getIconForState(watchedRun.status.overallState, watchedRun.status.conclusion, watchedRun.hasWarning);
    this.contextValue = watchedRun.status.overallState === 'completed' ? 'watchedRun.completed' : 'watchedRun.active';
  }

  private buildTooltip(): string {
    const run = this.watchedRun;
    const lines = [run.identifier.displayName];
    
    if (run.identifier.repo) {
      lines.push(`Repository: ${run.identifier.repo}`);
    }
    lines.push(`Run: #${run.identifier.runId}`);
    
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
    const parts: string[] = [];
    if (run.identifier.repo) {
      parts.push(run.identifier.repo);
    }
    parts.push(`#${run.identifier.runId}`);
    if (run.hasWarning) {
      parts.push('polling failed');
    } else if (run.status.overallState === 'completed' && run.status.conclusion) {
      parts.push(run.status.conclusion);
    } else {
      parts.push(run.status.overallState);
    }
    return parts.join(' · ');
  }

  private getIconForState(state: RunState, conclusion: RunConclusion | undefined, hasWarning?: boolean): vscode.ThemeIcon {
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
    public readonly conclusion?: RunConclusion
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

  private getIconForJobState(state: RunState, conclusion: RunConclusion | undefined): vscode.ThemeIcon {
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

interface WatchProviderGroupNode {
  kind: 'watchProviderGroup';
  providerId: string;
  label: string;
}

/**
 * Tree data provider for the Watches view.
 */
export class WatchesTreeProvider implements vscode.TreeDataProvider<WatchedRunNode | JobStatusNode | WatchProviderGroupNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WatchedRunNode | JobStatusNode | WatchProviderGroupNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _layout: ViewLayout = 'flat';
  private watchChangeSub: vscode.Disposable;

  get layout(): ViewLayout { return this._layout; }
  set layout(value: ViewLayout) {
    if (this._layout !== value) {
      this._layout = value;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  constructor(private watcherService: WatcherService) {
    // Listen for watch changes
    this.watchChangeSub = watcherService.onDidChangeWatchedRuns(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(element: WatchedRunNode | JobStatusNode | WatchProviderGroupNode): vscode.TreeItem {
    if ('kind' in element && element.kind === 'watchProviderGroup') {
      const watches = this.watcherService.getActiveWatches()
        .filter(w => w.identifier.providerId === element.providerId);
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.id = `watch-group:${element.providerId}`;
      treeItem.contextValue = 'watchProviderGroup';
      treeItem.iconPath = new vscode.ThemeIcon('plug');
      treeItem.description = `${watches.length}`;
      return treeItem;
    }
    return element;
  }

  getChildren(element?: WatchedRunNode | JobStatusNode | WatchProviderGroupNode): vscode.ProviderResult<(WatchedRunNode | JobStatusNode | WatchProviderGroupNode)[]> {
    if (!element) {
      const watches = this.watcherService.getActiveWatches();
      if (this._layout === 'flat') {
        return watches.map(watch => {
          const jobNodes = watch.status.jobs.map(
            job => new JobStatusNode(job.name, job.state, job.conclusion)
          );
          return new WatchedRunNode(watch, jobNodes);
        });
      }
      // Tree mode: group by provider
      const providers = new Map<string, WatchedRun[]>();
      for (const watch of watches) {
        const pid = watch.identifier.providerId;
        if (!providers.has(pid)) {
          providers.set(pid, []);
        }
        providers.get(pid)!.push(watch);
      }
      return Array.from(providers.entries()).map(([pid, _runs]) => {
        const label = this.watcherService.getProviderLabel(pid) ?? pid;
        return { kind: 'watchProviderGroup' as const, providerId: pid, label };
      });
    }

    if ('kind' in element && element.kind === 'watchProviderGroup') {
      const watches = this.watcherService.getActiveWatches()
        .filter(w => w.identifier.providerId === element.providerId);
      return watches.map(watch => {
        const jobNodes = watch.status.jobs.map(
          job => new JobStatusNode(job.name, job.state, job.conclusion)
        );
        return new WatchedRunNode(watch, jobNodes);
      });
    }

    if (element instanceof WatchedRunNode) {
      return element.watchedRun.status.jobs.map(
        job => new JobStatusNode(job.name, job.state, job.conclusion)
      );
    }

    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this.watchChangeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

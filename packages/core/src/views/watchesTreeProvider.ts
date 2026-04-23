import * as vscode from 'vscode';
import type { RunState, RunConclusion, PRState } from '@devdocket/shared';
import { WatcherService, WatchedRun, WatchedPR } from '../services/watcherService';
import { ViewLayout, LayoutState } from './viewLayout';

/**
 * Tree item for a watched PR.
 */
class WatchedPRNode extends vscode.TreeItem {
  constructor(
    public readonly watchedPR: WatchedPR,
    public readonly children: WatchedRunNode[]
  ) {
    const label = watchedPR.identifier.displayName;
    super(label, children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);

    this.id = `watch-pr:${watchedPR.identifier.providerId}:${watchedPR.identifier.repo}:${watchedPR.identifier.prId}`;
    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.getIconForPRState(watchedPR.prState, watchedPR.hasWarning);
    this.contextValue = watchedPR.prState === 'open' ? 'watchedPR.active' : 'watchedPR.completed';
  }

  private buildTooltip(): string {
    const pr = this.watchedPR;
    const lines = [pr.identifier.displayName];
    lines.push(`Repository: ${pr.identifier.repo}`);
    lines.push(`PR State: ${pr.prState}`);
    lines.push(`Child Runs: ${this.children.length}`);
    if (pr.hasWarning && pr.errorMessage) {
      lines.push(`Warning: ${pr.errorMessage}`);
    }
    return lines.join('\n');
  }

  private buildDescription(): string {
    const pr = this.watchedPR;
    const parts: string[] = [pr.identifier.repo];
    if (pr.hasWarning) {
      parts.push('polling failed');
    } else {
      parts.push(pr.prState);
    }
    return parts.join(' · ');
  }

  private getIconForPRState(state: PRState, hasWarning?: boolean): vscode.ThemeIcon {
    if (hasWarning) {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    }
    if (state === 'open') {
      return new vscode.ThemeIcon('git-pull-request');
    }
    if (state === 'merged') {
      return new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('testing.iconPassed'));
    }
    // closed
    return new vscode.ThemeIcon('git-pull-request-closed', new vscode.ThemeColor('testing.iconFailed'));
  }
}

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

type WatchTreeElement = WatchedPRNode | WatchedRunNode | JobStatusNode | WatchProviderGroupNode;

/**
 * Tree data provider for the Watches view.
 */
export class WatchesTreeProvider implements vscode.TreeDataProvider<WatchTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WatchTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _layoutState: LayoutState;
  private watchChangeSub: vscode.Disposable;
  private prChangeSub: vscode.Disposable;

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(private watcherService: WatcherService) {
    this._layoutState = new LayoutState('flat', () => this._onDidChangeTreeData.fire(undefined));
    // Listen for watch changes
    this.watchChangeSub = watcherService.onDidChangeWatchedRuns(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
    this.prChangeSub = watcherService.onDidChangePRWatches(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(element: WatchTreeElement): vscode.TreeItem {
    if ('kind' in element && element.kind === 'watchProviderGroup') {
      const allRuns = this.watcherService.getActiveStandaloneWatches()
        .filter(w => w.identifier.providerId === element.providerId);
      const allPRs = this.watcherService.getActivePRWatches()
        .filter(pr => pr.identifier.providerId === element.providerId);
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.id = `watch-group:${element.providerId}`;
      treeItem.contextValue = 'watchProviderGroup';
      treeItem.iconPath = new vscode.ThemeIcon('plug');
      treeItem.description = `${allRuns.length + allPRs.length}`;
      return treeItem;
    }
    return element;
  }

  getChildren(element?: WatchTreeElement): vscode.ProviderResult<WatchTreeElement[]> {
    if (!element) {
      if (this._layoutState.value === 'flat') {
        return this.buildFlatChildren();
      }
      // Tree mode: group by provider
      return this.buildGroupedRoots();
    }

    if ('kind' in element && element.kind === 'watchProviderGroup') {
      return this.buildProviderChildren(element.providerId);
    }

    if (element instanceof WatchedPRNode) {
      return element.children;
    }

    if (element instanceof WatchedRunNode) {
      return element.watchedRun.status.jobs.map(
        job => new JobStatusNode(job.name, job.state, job.conclusion)
      );
    }

    return [];
  }

  private buildFlatChildren(): WatchTreeElement[] {
    const result: WatchTreeElement[] = [];

    // Add PR watch nodes
    const prWatches = this.watcherService.getActivePRWatches();
    for (const prWatch of prWatches) {
      result.push(this.buildPRNode(prWatch));
    }

    // Add standalone run nodes
    const standaloneWatches = this.watcherService.getActiveStandaloneWatches();
    for (const watch of standaloneWatches) {
      const jobNodes = watch.status.jobs.map(
        job => new JobStatusNode(job.name, job.state, job.conclusion)
      );
      result.push(new WatchedRunNode(watch, jobNodes));
    }

    return result;
  }

  private buildGroupedRoots(): WatchTreeElement[] {
    const providers = new Map<string, boolean>();
    for (const watch of this.watcherService.getActiveStandaloneWatches()) {
      providers.set(watch.identifier.providerId, true);
    }
    for (const prWatch of this.watcherService.getActivePRWatches()) {
      providers.set(prWatch.identifier.providerId, true);
    }
    return Array.from(providers.keys()).map(pid => {
      const label = this.watcherService.getProviderLabel(pid) ?? pid;
      return { kind: 'watchProviderGroup' as const, providerId: pid, label };
    });
  }

  private buildProviderChildren(providerId: string): WatchTreeElement[] {
    const result: WatchTreeElement[] = [];

    // PR watches for this provider
    const prWatches = this.watcherService.getActivePRWatches()
      .filter(pr => pr.identifier.providerId === providerId);
    for (const prWatch of prWatches) {
      result.push(this.buildPRNode(prWatch));
    }

    // Standalone run watches for this provider
    const standaloneWatches = this.watcherService.getActiveStandaloneWatches()
      .filter(w => w.identifier.providerId === providerId);
    for (const watch of standaloneWatches) {
      const jobNodes = watch.status.jobs.map(
        job => new JobStatusNode(job.name, job.state, job.conclusion)
      );
      result.push(new WatchedRunNode(watch, jobNodes));
    }

    return result;
  }

  private buildPRNode(prWatch: WatchedPR): WatchedPRNode {
    const prKey = this.watcherService.getPRWatchKey(prWatch.identifier);
    const childRuns = this.watcherService.getChildRuns(prKey);
    const childNodes = childRuns.map(run => {
      const jobNodes = run.status.jobs.map(
        job => new JobStatusNode(job.name, job.state, job.conclusion)
      );
      return new WatchedRunNode(run, jobNodes);
    });
    return new WatchedPRNode(prWatch, childNodes);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this.watchChangeSub.dispose();
    this.prChangeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

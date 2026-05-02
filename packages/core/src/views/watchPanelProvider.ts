import * as vscode from 'vscode';
import type { PRIdentifier, RunConclusion, RunIdentifier, RunState } from '@devdocket/shared';
import { WatcherService, type WatchedPR, type WatchedRun } from '../services/watcherService';
import { isSafeUrl } from '../utils/url';
import type { PRWatchData, RunWatchData, WebviewMessage } from './mainTypes';

export class WatchPanelProvider implements vscode.Disposable {
  static readonly viewType = 'devdocket.watchPanel';

  private panel?: vscode.WebviewPanel;
  private panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly watcherService: WatcherService,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      WatchPanelProvider.viewType,
      'CI Watches',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-dist')],
      },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panelDisposables = [
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => {
        this.clearPanel();
      }),
    ];

    this.refresh();
  }

  refresh(): void {
    if (!this.panel) {
      return;
    }

    const prWatches = this.watcherService
      .getActivePRWatches()
      .map(prWatch => this.toPRWatchData(prWatch))
      .sort((a, b) => comparePRWatches(a, b));
    const runWatches = this.watcherService
      .getActiveStandaloneWatches()
      .map(runWatch => this.toRunWatchData(runWatch))
      .sort((a, b) => compareRunWatches(a, b));

    const totalCount = prWatches.length + runWatches.length;
    this.panel.title = totalCount > 0 ? `CI Watches (${totalCount})` : 'CI Watches';
    void this.panel.webview.postMessage({
      type: 'updateWatchPanel',
      prWatches,
      runWatches,
    });
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
    }
    this.clearPanel();
  }

  private clearPanel(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
    this.panel = undefined;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'dismissCompletedWatches':
        this.watcherService.dismissAllCompleted();
        break;
      case 'openWatchUrl': {
        const safeUrl = isSafeUrl(message.url);
        if (!safeUrl) {
          await vscode.window.showWarningMessage('Can only open http(s) URLs in the browser.');
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
        break;
      }
      case 'dismissWatch':
        this.dismissWatchById(message.watchId);
        break;
      default:
        break;
    }
  }

  private dismissWatchById(watchId: string): void {
    const prWatch = this.watcherService
      .getActivePRWatches()
      .find(watch => this.getPRPanelId(watch.identifier) === watchId);
    if (prWatch) {
      this.watcherService.dismissPRWatch(prWatch.identifier);
      return;
    }

    const runWatch = this.watcherService
      .getActiveWatches()
      .find(watch => this.getRunPanelId(watch.identifier) === watchId);
    if (runWatch) {
      this.watcherService.dismissWatch(runWatch.identifier);
    }
  }

  private toPRWatchData(prWatch: WatchedPR): PRWatchData {
    const prKey = this.watcherService.getPRWatchKey(prWatch.identifier);
    return {
      id: this.getPRPanelId(prWatch.identifier),
      title: prWatch.identifier.displayName,
      repo: prWatch.identifier.repo,
      state: prWatch.prState,
      url: prWatch.identifier.url,
      runs: this.watcherService
        .getChildRuns(prKey)
        .map(runWatch => this.toRunWatchData(runWatch))
        .sort((a, b) => compareRunWatches(a, b)),
      hasWarning: prWatch.hasWarning,
      errorMessage: prWatch.errorMessage,
    };
  }

  private toRunWatchData(runWatch: WatchedRun): RunWatchData {
    return {
      id: this.getRunPanelId(runWatch.identifier),
      name: runWatch.identifier.displayName,
      repo: runWatch.identifier.repo ?? this.watcherService.getProviderLabel(runWatch.identifier.providerId) ?? runWatch.identifier.providerId,
      state: toPanelRunState(runWatch.status.overallState),
      conclusion: runWatch.status.conclusion,
      url: runWatch.identifier.url,
      elapsedTime: formatElapsedTime(runWatch.status.startedAt ?? runWatch.watchedAt, runWatch.status.completedAt),
      hasWarning: runWatch.hasWarning,
      errorMessage: runWatch.errorMessage,
      failurePreview: getFailurePreview(runWatch),
    };
  }

  private getRunPanelId(identifier: RunIdentifier): string {
    return `run:${identifier.providerId}:${identifier.repo ?? ''}:${identifier.runId}`;
  }

  private getPRPanelId(identifier: PRIdentifier): string {
    return `pr:${identifier.providerId}:${identifier.repo}:${identifier.prId}`;
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview-dist', 'watchPanel.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>CI Watches</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
    }
    #root {
      min-height: 100vh;
    }
    .watch-panel {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .watch-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .watch-header-copy {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .watch-title {
      font-size: 16px;
      font-weight: 600;
    }
    .watch-subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .link-button,
    .icon-button {
      border: none;
      background: transparent;
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      cursor: pointer;
      font: inherit;
      padding: 0;
    }
    .link-button[disabled] {
      cursor: default;
      opacity: 0.55;
      pointer-events: none;
    }
    .icon-button {
      color: var(--vscode-descriptionForeground);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      line-height: 1.4;
    }
    .icon-button:hover,
    .icon-button:focus-visible,
    .link-button:hover,
    .link-button:focus-visible {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.12));
      outline: none;
    }
    .watch-sections {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .watch-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .watch-section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .watch-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .watch-card {
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 8px;
      overflow: hidden;
    }
    .watch-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
    }
    .watch-row.clickable {
      cursor: pointer;
    }
    .watch-row.clickable:hover,
    .watch-row.clickable:focus-visible {
      background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.08));
      outline: none;
    }
    .watch-row-main {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .watch-row-top {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .watch-row-icon {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }
    .watch-row-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .watch-row-meta,
    .watch-row-preview,
    .watch-empty {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .watch-row-preview {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .watch-row-preview.warning {
      color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
    }
    .watch-row-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .watch-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .watch-children {
      display: flex;
      flex-direction: column;
      gap: 1px;
      border-top: 1px solid var(--vscode-widget-border, transparent);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      padding-left: 20px;
    }
    .watch-child-row {
      border-left: 2px solid var(--vscode-widget-border, transparent);
    }
    .badge-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.4;
      white-space: nowrap;
    }
    .empty-state {
      padding: 28px 16px;
      border: 1px dashed var(--vscode-widget-border, transparent);
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function toPanelRunState(state: RunState): RunWatchData['state'] {
  switch (state) {
    case 'running':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      return 'queued';
  }
}

function getFailurePreview(runWatch: WatchedRun): string | undefined {
  if (runWatch.hasWarning && runWatch.errorMessage) {
    return truncate(runWatch.errorMessage);
  }

  const failedJobs = runWatch.status.jobs
    .filter(job => job.state === 'completed' && job.conclusion === 'failure')
    .map(job => job.name);
  if (failedJobs.length > 0) {
    if (failedJobs.length === 1) {
      return `Failed job: ${failedJobs[0]}`;
    }
    const visibleJobs = failedJobs.slice(0, 2).join(', ');
    const remainder = failedJobs.length > 2 ? ` +${failedJobs.length - 2} more` : '';
    return `Failed jobs: ${visibleJobs}${remainder}`;
  }

  if (runWatch.status.overallState === 'completed' && runWatch.status.conclusion && runWatch.status.conclusion !== 'success') {
    return `Conclusion: ${toDisplayLabel(runWatch.status.conclusion)}`;
  }

  return undefined;
}

function formatElapsedTime(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt) {
    return undefined;
  }

  const startTime = Date.parse(startedAt);
  if (Number.isNaN(startTime)) {
    return undefined;
  }

  const endTime = completedAt ? Date.parse(completedAt) : Date.now();
  if (Number.isNaN(endTime)) {
    return undefined;
  }

  const totalSeconds = Math.max(0, Math.round((endTime - startTime) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${totalMinutes}m`;
}

function comparePRWatches(a: PRWatchData, b: PRWatchData): number {
  return getPRPriority(a) - getPRPriority(b) || a.title.localeCompare(b.title);
}

function getPRPriority(prWatch: PRWatchData): number {
  if (prWatch.hasWarning) {
    return 0;
  }
  if (prWatch.runs.some(runWatch => getRunPriority(runWatch) <= 1)) {
    return 1;
  }
  if (prWatch.state === 'open') {
    return 2;
  }
  if (prWatch.state === 'merged') {
    return 3;
  }
  return 4;
}

function compareRunWatches(a: RunWatchData, b: RunWatchData): number {
  return getRunPriority(a) - getRunPriority(b) || a.name.localeCompare(b.name);
}

function getRunPriority(runWatch: RunWatchData): number {
  if (runWatch.hasWarning || isFailedRun(runWatch)) {
    return 0;
  }
  if (runWatch.state !== 'completed') {
    return 1;
  }
  if (runWatch.conclusion === 'success') {
    return 2;
  }
  return 3;
}

function isFailedRun(runWatch: RunWatchData): boolean {
  return runWatch.state === 'completed' && runWatch.conclusion !== undefined && runWatch.conclusion !== 'success';
}

function truncate(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function toDisplayLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

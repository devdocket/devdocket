import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { PRIdentifier, RunIdentifier, RunState } from '@devdocket/shared';
import { WatcherService, type WatchedPR, type WatchedRun } from '../services/watcherService';
import type { WorkItem } from '../models/workItem';
import type { ProviderRegistry } from '../services/providerRegistry';
import type { WorkGraph } from '../services/workGraph';
import { isSafeUrl } from '../utils/url';
import { buildTierColorCss } from '../webview/shared/colors';
import { isFailedConclusion, toConclusionLabel } from '../webview/shared/runConclusionLabels';
import { parseProviderItemKey } from './providerItemKey';
import type { PRWatchData, RunWatchData, WebviewMessage } from './mainTypes';

export class WatchPanelProvider implements vscode.Disposable {
  static readonly viewType = 'devdocket.watchPanel';

  private panel?: vscode.WebviewPanel;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly refreshDisposables: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly watcherService: WatcherService,
    private readonly workGraph: WorkGraph,
    _providerRegistry: ProviderRegistry,
  ) {
    this.refreshDisposables = [
      this.workGraph.onDidChange(() => this.refresh()),
    ];
  }

  createSerializer(): vscode.WebviewPanelSerializer {
    return {
      deserializeWebviewPanel: async (panel): Promise<void> => {
        this.revive(panel);
      },
    };
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      WatchPanelProvider.viewType,
      'CI Watches',
      vscode.ViewColumn.Beside,
      this.getWebviewOptions(),
    );

    this.attachPanel(panel);
  }

  revive(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) {
      this.panel.dispose();
    }
    this.attachPanel(panel);
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.clearPanel();
    this.panel = panel;
    this.panel.webview.options = this.getWebviewOptions();
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panelDisposables = [
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => {
        this.clearPanel();
      }),
      // Only treat "user is looking" as the panel actually being focused.
      // Just being visible in another column doesn't mean the user noticed
      // a newly-arrived failure.
      this.panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) {
          this.watcherService.acknowledgeAllFailures();
        }
      }),
    ];

    this.refresh();
  }

  private getWebviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-dist')],
    };
  }

  refresh(): void {
    if (!this.panel) {
      return;
    }

    const activePRWatches = this.watcherService.getActivePRWatches();
    const linkedPRTargets = activePRWatches.length > 0 ? this.buildLinkedPRTargetIndex() : new Map<string, LinkedPRTarget>();
    const prWatches = activePRWatches
      .map(prWatch => this.toPRWatchData(prWatch, linkedPRTargets))
      .filter(prWatch => prWatch.runs.length > 0)
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

    // Only auto-acknowledge while the user is actually focused on the panel
    // (not merely if the panel is open in some other column).
    if (this.panel.active) {
      this.watcherService.acknowledgeAllFailures();
    }
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
    }
    this.clearPanel();
    for (const disposable of this.refreshDisposables.splice(0)) {
      disposable.dispose();
    }
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
      case 'dismissCompletedWatches': {
        // Route through the shared command so the confirmation prompt and
        // logging stay in one place.
        await vscode.commands.executeCommand('devdocket.dismissAllCompletedWatches');
        break;
      }
      case 'openWatchUrl': {
        const safeUrl = isSafeUrl(message.url);
        if (!safeUrl) {
          await vscode.window.showWarningMessage('Can only open http(s) URLs in the browser.');
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
        break;
      }
      case 'openItem': {
        await this.openItem(message);
        break;
      }
      case 'dismissWatch':
        this.dismissWatchById(message.watchId);
        break;
      case 'addWatchUrl':
        await vscode.commands.executeCommand('devdocket.watchUrl');
        break;
      case 'watchPanelReady':
        // The webview has mounted and attached its message listener.
        // Re-send the current snapshot so it doesn't miss the initial refresh
        // that may have been posted before the listener was wired.
        this.refresh();
        break;
      default:
        break;
    }
  }

  private async openItem(message: Extract<WebviewMessage, { type: 'openItem' }>): Promise<void> {
    if (typeof message.itemId !== 'string') {
      return;
    }

    const workItem = this.workGraph.getItem(message.itemId);
    if (workItem) {
      await vscode.commands.executeCommand('devdocket.editItem', { id: message.itemId });
      return;
    }

    const messageProviderId = typeof message.providerId === 'string' ? message.providerId : undefined;
    const messageExternalId = typeof message.externalId === 'string' ? message.externalId : undefined;
    const providerItemKey = messageProviderId && messageExternalId ? undefined : parseProviderItemKey(message.itemId);
    const providerId = messageProviderId ?? providerItemKey?.providerId;
    const externalId = messageExternalId ?? providerItemKey?.externalId;
    if (providerId && externalId) {
      await vscode.commands.executeCommand('devdocket.previewIncomingItem', { providerId, externalId });
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

  private buildLinkedPRTargetIndex(): Map<string, LinkedPRTarget> {
    const linkedTargets = new Map<string, LinkedPRTarget>();
    for (const item of this.workGraph.getAll()) {
      if (isPRWorkItem(item)) {
        linkedTargets.set(item.externalId, { linkedItemId: item.id });
      }
    }

    return linkedTargets;
  }

  private toPRWatchData(prWatch: WatchedPR, linkedPRTargets: ReadonlyMap<string, LinkedPRTarget>): PRWatchData {
    const prKey = this.watcherService.getPRWatchKey(prWatch.identifier);
    const linkedTarget = getPRExternalIds(prWatch.identifier)
      .map(externalId => linkedPRTargets.get(externalId))
      .find((target): target is LinkedPRTarget => target !== undefined);
    return {
      id: this.getPRPanelId(prWatch.identifier),
      title: prWatch.identifier.displayName,
      repo: prWatch.identifier.repo,
      state: prWatch.prState,
      url: prWatch.identifier.url,
      ...(linkedTarget ?? {}),
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
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview-dist', 'codicons', 'codicon.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>CI Watches</title>
  <link rel="stylesheet" href="${codiconsUri}">
  <style nonce="${nonce}">
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
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .watch-header {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      padding: 0 4px;
    }
    .tiers {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .tier-section {
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      padding: 10px 6px;
    }
    .tier-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tier-header-main,
    .tier-toggle-button,
    .tier-header-action {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0;
      font: inherit;
    }
    .tier-header-main {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
      text-align: left;
    }
    .tier-header-action {
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    }
    .tier-header-action:hover:not([disabled]) {
      text-decoration: underline;
    }
    .tier-header-action[disabled] {
      cursor: default;
      opacity: 0.55;
      pointer-events: none;
    }
    .tier-toggle-button {
      display: inline-flex;
      align-items: center;
    }
    .tier-header-main:focus-visible,
    .tier-toggle-button:focus-visible,
    .tier-header-action:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .tier-count,
    .tier-toggle {
      color: var(--vscode-descriptionForeground);
    }
    .tier-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }
    .item-card {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px 10px 8px 12px;
      border-radius: 6px;
      background: var(--vscode-editor-background);
      border-left: 3px solid transparent;
      cursor: pointer;
    }
    .item-card-row {
      position: relative;
      display: flex;
      align-items: stretch;
      gap: 10px;
    }
    .item-card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .item-card:hover {
      background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
    }
    .item-card-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .item-card.item-card--incoming { border-left-color: var(--tier-incoming); }
    .item-card.item-card--in-progress { border-left-color: var(--tier-in-progress); }
    .item-card.item-card--ready-to-start { border-left-color: var(--tier-ready); }
    .item-card.item-card--paused { border-left-color: var(--tier-paused); }
    .item-card.item-card--done { border-left-color: var(--tier-done); }
    .item-card.item-card--urgent { border-left-color: var(--tier-urgent); }
    .item-line-1 {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .item-title-wrap {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .item-title {
      font-weight: 600;
      word-break: break-word;
    }
    .item-repo-annotation {
      font-weight: 400;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      opacity: 0.75;
      word-break: break-all;
    }
    .watch-row-preview {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .watch-row-preview.warning {
      color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
    }
    .watch-run-summary {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .watch-disclosure-button {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      line-height: 1;
    }
    .watch-disclosure-button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
      color: var(--vscode-foreground);
    }
    .watch-disclosure-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .watch-card-details {
      margin-left: 10px;
      padding-left: 10px;
      border-left: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.35));
    }
    .nested-run-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .watch-card-details .item-card {
      padding: 7px 9px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-left-width: 2px;
    }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
      align-items: center;
    }
    .watch-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .item-actions {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      gap: 6px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s;
      padding: 4px 6px;
      border-radius: 6px;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent));
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    }
    .item-card:hover .item-actions,
    .item-card:focus-within .item-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .item-action-btn {
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: 4px;
      padding: 4px 9px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .item-action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
    }
    .item-action-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
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
    :root {
      ${buildTierColorCss('dark')}
    }
    body.vscode-light {
      ${buildTierColorCss('light')}
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

interface LinkedPRTarget {
  linkedItemId?: string;
}

const PR_EMITTING_PROVIDER_IDS = new Set([
  'github-my-prs',
  'github-pr-reviews',
  'github-mentions',
  'ado-my-prs',
  'ado-pr-reviews',
]);

function getPRExternalIds(identifier: PRIdentifier): string[] {
  return [`${identifier.repo}#${identifier.prId}`, `${identifier.repo}/${identifier.prId}`];
}

function isPRWorkItem(item: WorkItem): item is WorkItem & { providerId: string; externalId: string } {
  return Boolean(item.providerId && item.externalId && isPRCandidate(item.providerId, item.itemType));
}

function isPRCandidate(providerId: string, itemType: 'issue' | 'pr' | undefined): boolean {
  return itemType === 'pr' || (itemType === undefined && PR_EMITTING_PROVIDER_IDS.has(providerId));
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
    return `Conclusion: ${toConclusionLabel(runWatch.status.conclusion)}`;
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
  if (runWatch.state !== 'completed') return false;
  // Delegate to the shared helper so all CI watch surfaces agree on what counts as a failed run.
  return isFailedConclusion(runWatch.conclusion);
}

function truncate(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}


function getNonce(): string {
  // Cryptographically random nonce (matches editorPanelHtml). Math.random
  // is seeded per-process and predictable, which would make CSP a paper
  // shield if any future change introduced user-controlled HTML.
  return crypto.randomBytes(16).toString('hex');
}

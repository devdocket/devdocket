import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import {
  abortFromToken,
  WorkItemState,
  type ActivityLogEntry,
  type ActivityType,
  type ProviderItem,
  type GitWorkInfo,
  type WorkItem,
  type DevDocketAction,
} from '@devdocket/shared';
import { promptGitCleanup } from './gitCleanup';
import { decodeWorkStartedDetail, encodeWorkStartedDetail } from './workStartedDetail';

const execFileAsync = promisify(execFile);

/** Strict allowlist for git ref names — blocks argument injection via leading hyphens. */
const SAFE_REF = /^[a-zA-Z0-9._\/-]+$/;

function isValidRef(ref: unknown): ref is string {
  if (typeof ref !== 'string'
    || ref.length === 0
    || ref.startsWith('-')
    || !SAFE_REF.test(ref)
    || ref.endsWith('/')
    || ref.endsWith('.')
    || ref.includes('//')
    || ref.includes('..')
    || ref.includes('@{')
    || ref === '@') {
    return false;
  }

  return ref.split('/').every(segment => segment.length > 0
    && !segment.startsWith('.')
    && !segment.endsWith('.lock'));
}

/** Rejects whitespace and control characters in clone URLs. */
const UNSAFE_URL_CHARS = /[\s\x00-\x1f\x7f]/;

function isValidCloneUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || UNSAFE_URL_CHARS.test(url)) {
    return false;
  }
  if (url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:'
        && parsed.hostname.length > 0
        && !parsed.username
        && !parsed.password
        && !parsed.search
        && !parsed.hash;
    } catch {
      return false;
    }
  }
  return isValidGitSshCloneUrl(url);
}

function isValidGitSshCloneUrl(url: string): boolean {
  const match = url.match(/^git@([^:]+):(.+)$/);
  if (!match) {
    return false;
  }
  const [, host, repoPath] = match;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && repoPath.length > 0;
}

/** Timeout for lightweight git metadata commands (branch --list, status, rev-parse). */
const GIT_METADATA_TIMEOUT = 30_000;
/** Timeout for heavy git operations that touch the working tree (worktree add, checkout, fetch). */
const GIT_CHECKOUT_TIMEOUT = 300_000;

type GetProviderItem = (providerId: string, externalId: string) => ProviderItem | undefined;

type ResolvedGitWork = GitWorkInfo & { cloneUrl: string; ref: string };

type WorkMode = 'checkout' | 'worktree';

type RepoPathPick = vscode.QuickPickItem & (
  | { pickKind: 'repo'; repoPath: string }
  | { pickKind: 'paste' }
  | { pickKind: 'browse' }
);

interface PrBranchInfo {
  branchName: string;
  sourceRef: string;
  /** Remote tracking ref when branch is on a non-origin remote (e.g. "devdocket-fork-contributor/fix-bug"). */
  trackingRef?: string;
}

interface FlowCancellationState {
  currentStep: string;
  cleanupActivity?: ActivityLogEntry;
}

/**
 * DevDocket action that bootstraps a development environment for a work item.
 *
 * Supports any provider that attaches a gitWork capability to its live
 * discovered item. The action consumes only provider-supplied git metadata;
 * it does not know about provider ids, URL hosts, or provider HTTP APIs.
 */
export class StartWorkAction implements DevDocketAction {
  readonly id = 'startGitWork';
  readonly label = 'Start Git Work';

  private readonly globalState: vscode.Memento;

  constructor(
    globalState: vscode.Memento,
    private readonly getProviderItem: GetProviderItem = () => undefined,
  ) {
    this.globalState = globalState;
  }

  canRun(item: Readonly<WorkItem>): boolean {
    if (item.state !== WorkItemState.InProgress || !item.providerId || !item.externalId) {
      return false;
    }

    return !!this.getProviderItem(item.providerId, item.externalId)?.capabilities?.gitWork;
  }

  async run(item: Readonly<WorkItem>): Promise<void> {
    const gitWork = await this.resolveGitWork(item);
    if (!gitWork) {
      void vscode.window.showErrorMessage('DevDocket: This work item is not supported by Start Git Work.');
      return;
    }

    if (!this.validateGitWork(gitWork)) {
      return;
    }

    const repoLabel = gitWork.repoLabel ?? gitWork.cloneUrl;
    const repoPath = await this.promptForRepoPath(repoLabel);
    if (!repoPath) {
      return;
    }

    if (gitWork.kind === 'pr') {
      await this.runPrFlow(item, gitWork, repoPath);
    } else {
      await this.runIssueFlow(item, gitWork, repoPath);
    }
  }

  private async resolveGitWork(item: Readonly<WorkItem>): Promise<GitWorkInfo | undefined> {
    if (!item.providerId || !item.externalId) {
      return undefined;
    }

    const capability = this.getProviderItem(item.providerId, item.externalId)?.capabilities?.gitWork;
    if (!capability) {
      return undefined;
    }

    try {
      return typeof capability === 'function' ? await capability() : capability;
    } catch (err) {
      logger.error('Provider gitWork capability failed', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`DevDocket: Could not resolve git work information — ${message}`);
      return undefined;
    }
  }

  private validateGitWork(gitWork: GitWorkInfo): gitWork is ResolvedGitWork {
    if (gitWork.kind !== 'issue' && gitWork.kind !== 'pr') {
      logger.warn('Provider returned invalid gitWork kind');
      void vscode.window.showErrorMessage('DevDocket: Provider returned an invalid git work kind for this item.');
      return false;
    }
    if (!isValidCloneUrl(gitWork.cloneUrl)) {
      logger.warn(`Provider returned invalid gitWork cloneUrl for ${gitWork.kind}`);
      void vscode.window.showErrorMessage('DevDocket: Provider returned an invalid clone URL for this work item.');
      return false;
    }
    if (typeof gitWork.ref !== 'string') {
      logger.warn(`Provider returned invalid gitWork ref for ${gitWork.kind}`);
      void vscode.window.showErrorMessage('DevDocket: Provider returned an invalid git ref for this work item.');
      return false;
    }
    if (gitWork.ref.startsWith('refs/') && !gitWork.ref.startsWith('refs/heads/')) {
      logger.warn(`Provider returned unsupported gitWork ref: ${gitWork.ref}`);
      void vscode.window.showErrorMessage('DevDocket: Provider returned an unsupported git branch ref for this work item.');
      return false;
    }
    const ref = this.normalizeBranchName(gitWork.ref);
    if (!isValidRef(ref)) {
      logger.warn(`Provider returned invalid gitWork ref for ${gitWork.kind}`);
      void vscode.window.showErrorMessage('DevDocket: Provider returned an invalid git ref for this work item.');
      return false;
    }
    if (gitWork.headCloneUrl !== undefined && !isValidCloneUrl(gitWork.headCloneUrl)) {
      logger.warn('Provider returned invalid gitWork headCloneUrl for PR');
      void vscode.window.showErrorMessage('DevDocket: Provider returned an invalid PR source clone URL.');
      return false;
    }
    if (gitWork.baseRef !== undefined && !isValidRef(gitWork.baseRef)) {
      logger.warn('Provider returned invalid gitWork baseRef for PR');
      void vscode.window.showErrorMessage('DevDocket: Provider returned an invalid PR base ref.');
      return false;
    }
    return true;
  }

  private async runIssueFlow(
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
    repoPath: string,
  ): Promise<void> {
    let branchName = this.normalizeBranchName(gitWork.ref);
    const repoLabel = gitWork.repoLabel ?? gitWork.cloneUrl;

    const baseBranch = await this.promptForBaseBranch(repoLabel);
    if (!baseBranch) {
      return;
    }

    const workMode = await this.promptForWorkMode();
    if (!workMode) {
      return;
    }

    const promptForNames = this.shouldPromptForNames();

    const cancellationState: FlowCancellationState = { currentStep: workMode === 'worktree' ? 'creating worktree' : 'checking out branch' };

    try {
      let worktreePath: string | undefined;
      if (promptForNames) {
        const promptedBranchName = await this.promptForBranchName(branchName, workMode);
        if (promptedBranchName === undefined) {
          return;
        }
        branchName = promptedBranchName;

        if (workMode === 'worktree') {
          worktreePath = await this.promptForWorktreePath(repoPath, branchName, item, gitWork);
          if (worktreePath === undefined) {
            return;
          }
        }
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Starting git work for issue',
          cancellable: true,
        },
        async (progress, token) => {
          const abortController = abortFromToken(token);
          if (workMode === 'worktree') {
            await this.issueWorktreeFlow(item, gitWork, repoPath, branchName, baseBranch, progress, abortController.signal, cancellationState, worktreePath);
          } else {
            await this.issueCheckoutFlow(item, repoPath, branchName, baseBranch, progress, abortController.signal, cancellationState);
          }
        },
      );
    } catch (err: unknown) {
      if (await this.handleFlowCancellation(item, err, cancellationState)) {
        return;
      }
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`DevDocket: Failed to start work — ${message}`);
    }
  }

  private async issueWorktreeFlow(
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
    repoPath: string,
    branchName: string,
    baseBranch: string,
    progress: vscode.Progress<{ message?: string }>,
    signal: AbortSignal,
    cancellationState: FlowCancellationState,
    promptedWorktreePath?: string,
  ): Promise<void> {
    const worktreePath = promptedWorktreePath ?? this.getDefaultWorktreePath(repoPath, branchName, item, gitWork);

    if (fs.existsSync(worktreePath)) {
      void vscode.window.showErrorMessage(`DevDocket: Directory "${worktreePath}" already exists.`);
      return;
    }

    this.reportStep(progress, cancellationState, 'Creating branch...', 'creating branch');

    const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
    if (branchList.trim()) {
      void vscode.window.showErrorMessage(`DevDocket: Branch "${branchName}" already exists.`);
      return;
    }

    await execFileAsync('git', ['branch', branchName, baseBranch], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
    logger.info(`Starting work: creating branch ${branchName}`);
    cancellationState.cleanupActivity = {
      timestamp: Date.now(),
      type: 'work-started',
      detail: encodeWorkStartedDetail({ branchName, repoPath }),
    };

    this.reportStep(progress, cancellationState, 'Creating worktree...', 'creating worktree');

    try {
      await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
        cwd: repoPath,
        timeout: GIT_CHECKOUT_TIMEOUT,
        signal,
      });
    } catch (worktreeErr) {
      if (this.isAbortError(worktreeErr)) {
        try {
          await this.rollbackCreatedBranch(branchName, baseBranch, repoPath);
          cancellationState.cleanupActivity = undefined;
        } catch (rollbackErr) {
          const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          void vscode.window.showWarningMessage(`DevDocket: Failed to delete branch during rollback — ${rollbackMessage}`);
        }
        throw worktreeErr;
      }

      try {
        await this.rollbackCreatedBranch(branchName, baseBranch, repoPath);
      } catch (rollbackErr) {
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        void vscode.window.showWarningMessage(`DevDocket: Failed to delete branch during rollback — ${rollbackMessage}`);
      }

      const errMsg = worktreeErr instanceof Error ? worktreeErr.message : String(worktreeErr);
      const errStderr = (worktreeErr as any)?.stderr ?? '';
      if (errMsg.includes('already exists') || errStderr.includes('already exists')) {
        void vscode.window.showErrorMessage(`DevDocket: Directory "${worktreePath}" already exists.`);
        return;
      }
      throw worktreeErr;
    }

    logger.info(`Created worktree at ${worktreePath}`);

    const detail = encodeWorkStartedDetail({ branchName, worktreePath, repoPath });
    cancellationState.cleanupActivity = { timestamp: Date.now(), type: 'work-started', detail };
    try {
      await this.addActivity(item.id, 'work-started', detail);
    } catch (activityErr) {
      logger.error('Failed to log work-started activity', activityErr);
      void vscode.window.showWarningMessage(
        `DevDocket: Worktree created but failed to log activity — cleanup prompt may not work`,
      );
    }

    await this.runPostWorktreeCommands(worktreePath, progress, signal, cancellationState);

    void vscode.window.showInformationMessage(
      `DevDocket: Created worktree for ${branchName}`,
    );
  }

  private async issueCheckoutFlow(
    item: Readonly<WorkItem>,
    repoPath: string,
    branchName: string,
    baseBranch: string,
    progress: vscode.Progress<{ message?: string }>,
    signal: AbortSignal,
    cancellationState: FlowCancellationState,
  ): Promise<void> {
    const canProceed = await this.checkDirtyTree(repoPath, signal);
    if (!canProceed) {
      return;
    }

    this.reportStep(progress, cancellationState, 'Creating and checking out branch...', 'creating and checking out branch');

    await execFileAsync('git', ['checkout', '-b', branchName, baseBranch], { cwd: repoPath, timeout: GIT_CHECKOUT_TIMEOUT, signal });
    logger.info(`Starting work: checked out new branch ${branchName}`);

    try {
      const detail = encodeWorkStartedDetail({ branchName, repoPath });
      await this.addActivity(item.id, 'work-started', detail);
    } catch (activityErr) {
      logger.error('Failed to log work-started activity', activityErr);
      void vscode.window.showWarningMessage(
        `DevDocket: Branch checked out but failed to log activity — cleanup prompt may not work`,
      );
    }

    void vscode.window.showInformationMessage(
      `DevDocket: Checked out branch ${branchName}`,
    );
  }

  private async runPrFlow(
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
    repoPath: string,
  ): Promise<void> {
    const workMode = await this.promptForWorkMode();
    if (!workMode) {
      return;
    }

    const upstreamBranchName = this.normalizeBranchName(gitWork.ref);
    let branchName = upstreamBranchName;
    let worktreePath: string | undefined;
    if (this.shouldPromptForNames()) {
      // PR branch prompts rename only the local branch; fetch still uses the upstream ref.
      const promptedBranchName = await this.promptForBranchName(branchName, workMode);
      if (promptedBranchName === undefined) {
        return;
      }
      branchName = promptedBranchName;

      if (workMode === 'worktree') {
        worktreePath = await this.promptForWorktreePath(repoPath, branchName, item, gitWork);
        if (worktreePath === undefined) {
          return;
        }
      }
    }

    const cancellationState: FlowCancellationState = { currentStep: 'fetching PR branch' };

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Starting git work for PR',
          cancellable: true,
        },
        async (progress, token) => {
          const abortController = abortFromToken(token);
          this.reportStep(progress, cancellationState, 'Fetching PR branch...', 'fetching PR branch');

          const branchInfo = await this.fetchPrBranch(gitWork, repoPath, branchName, abortController.signal);
          if (!branchInfo) {
            return;
          }

          if (workMode === 'worktree') {
            await this.prWorktreeFlow(item, gitWork, repoPath, branchInfo, progress, abortController.signal, cancellationState, worktreePath);
          } else {
            await this.prCheckoutFlow(item, repoPath, branchInfo, progress, abortController.signal, cancellationState);
          }
        },
      );
    } catch (err: unknown) {
      if (await this.handleFlowCancellation(item, err, cancellationState)) {
        return;
      }
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`DevDocket: Failed to start work — ${message}`);
    }
  }

  private async fetchPrBranch(
    gitWork: ResolvedGitWork,
    repoPath: string,
    localBranchName?: string,
    signal?: AbortSignal,
  ): Promise<PrBranchInfo | undefined> {
    const upstreamBranchName = this.normalizeBranchName(gitWork.ref);
    const branchName = localBranchName ?? upstreamBranchName;
    const cloneUrl = gitWork.headCloneUrl ?? gitWork.cloneUrl;

    logger.info(`Fetching provider-supplied PR branch "${upstreamBranchName}"`);
    const remoteName = await this.findOrAddRemote(cloneUrl, gitWork.repoLabel, repoPath, signal);
    const sourceRef = `${remoteName}/${upstreamBranchName}`;

    try {
      await execFileAsync('git', [
        'fetch',
        remoteName,
        `+refs/heads/${upstreamBranchName}:refs/remotes/${remoteName}/${upstreamBranchName}`,
      ], { cwd: repoPath, timeout: GIT_CHECKOUT_TIMEOUT, signal });
      logger.debug(`Fetch complete for branch "${upstreamBranchName}" from remote "${remoteName}"`);
    } catch (err) {
      if (this.isAbortError(err)) {
        throw err;
      }
      const details = this.formatGitError(err);
      logger.info(`Failed to fetch branch "${upstreamBranchName}" from ${remoteName}: ${details}`);
      void vscode.window.showErrorMessage(
        `DevDocket: Could not fetch branch '${upstreamBranchName}' from remote '${remoteName}'. ${details}`,
      );
      return undefined;
    }

    if (remoteName === 'origin') {
      return { branchName, sourceRef };
    }
    return { branchName, sourceRef, trackingRef: sourceRef };
  }

  /**
   * Finds a local remote whose fetch URL matches {@link cloneUrl}, or adds a
   * new DevDocket-managed remote pointing to it.
   */
  private async findOrAddRemote(cloneUrl: string, repoLabel: string | undefined, repoPath: string, signal?: AbortSignal): Promise<string> {
    const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
      if (match && match[2] === cloneUrl) {
        const name = match[1];
        if (!isValidRef(name)) {
          logger.warn(`Skipping remote "${name}" — name contains unsafe characters`);
          continue;
        }
        logger.info(`Found existing remote "${name}" matching ${cloneUrl}`);
        return name;
      }
    }

    const remoteName = this.toRemoteName(cloneUrl, repoLabel);
    logger.debug(`No remote found for ${cloneUrl}, adding "${remoteName}"`);

    try {
      await execFileAsync('git', ['remote', 'add', remoteName, cloneUrl], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
      logger.info(`Added remote "${remoteName}" → ${cloneUrl}`);
    } catch (err) {
      if (this.isAbortError(err)) {
        throw err;
      }
      try {
        const { stdout: existingUrl } = await execFileAsync('git', ['remote', 'get-url', remoteName], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
        if (existingUrl.trim() !== cloneUrl) {
          logger.info(`Remote "${remoteName}" exists with different URL, updating to "${cloneUrl}".`);
          await execFileAsync('git', ['remote', 'set-url', remoteName, cloneUrl], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
        } else {
          logger.debug(`Remote "${remoteName}" already exists with correct URL`);
        }
      } catch {
        throw err;
      }
    }

    return remoteName;
  }

  private async prWorktreeFlow(
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
    repoPath: string,
    branchInfo: PrBranchInfo,
    progress: vscode.Progress<{ message?: string }>,
    signal: AbortSignal,
    cancellationState: FlowCancellationState,
    promptedWorktreePath?: string,
  ): Promise<void> {
    const { branchName, sourceRef, trackingRef } = branchInfo;
    const worktreePath = promptedWorktreePath ?? this.getDefaultWorktreePath(repoPath, branchName, item, gitWork);

    if (fs.existsSync(worktreePath)) {
      void vscode.window.showErrorMessage(`DevDocket: Directory "${worktreePath}" already exists.`);
      return;
    }

    this.reportStep(progress, cancellationState, 'Creating worktree...', 'creating worktree');

    // Determine worktree strategy based on whether a local branch already exists.
    // For fork PRs, always create from the remote tracking ref (detached if local branch
    // exists, to avoid using a stale/unrelated same-named local branch).
    // For same-repo PRs, the branch may only exist as origin/<branch> after fetch.
    const hasLocalBranch = await this.localBranchExists(branchName, repoPath, signal);
    const worktreeSourceRef = sourceRef;
    // Only relevant when we'd otherwise run `git worktree add <path> <branch>`
    // (the local-branch path that's neither --detach nor -b). For trackingRef
    // and no-local-branch paths, the porcelain pre-check would be wasted work.
    const conflictingWorktree =
      hasLocalBranch && !trackingRef
        ? await this.findWorktreeHoldingBranch(branchName, repoPath, undefined, signal)
        : undefined;
    let createdBranch = false;

    if (hasLocalBranch && trackingRef) {
      cancellationState.cleanupActivity = {
        timestamp: Date.now(),
        type: 'work-started',
        detail: encodeWorkStartedDetail({ worktreePath, repoPath }),
      };
      // PR with an existing local branch — the local branch may be stale or
      // tracking a different remote. Create a detached worktree from the PR ref.
      logger.info(
        `Local branch ${branchName} exists, but PR uses tracking ref ${trackingRef}; creating detached worktree from tracking ref`,
      );
      this.reportStep(progress, cancellationState, 'Creating detached worktree from PR tracking ref...', 'creating detached worktree');

      await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, trackingRef], {
        cwd: repoPath,
        timeout: GIT_CHECKOUT_TIMEOUT,
        signal,
      });
    } else if (hasLocalBranch && conflictingWorktree) {
      cancellationState.cleanupActivity = {
        timestamp: Date.now(),
        type: 'work-started',
        detail: encodeWorkStartedDetail({ worktreePath, repoPath }),
      };
      logger.info(
        `Branch ${branchName} is already held by worktree at ${conflictingWorktree}; creating detached worktree from ${worktreeSourceRef}`,
      );
      this.reportStep(progress, cancellationState, 'Branch in use elsewhere; creating detached worktree...', 'creating detached worktree');

      await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, worktreeSourceRef], {
        cwd: repoPath,
        timeout: GIT_CHECKOUT_TIMEOUT,
        signal,
      });
    } else if (hasLocalBranch) {
      cancellationState.cleanupActivity = {
        timestamp: Date.now(),
        type: 'work-started',
        detail: encodeWorkStartedDetail({ worktreePath, repoPath }),
      };
      await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
        cwd: repoPath,
        timeout: GIT_CHECKOUT_TIMEOUT,
        signal,
      });
    } else {
      cancellationState.cleanupActivity = {
        timestamp: Date.now(),
        type: 'work-started',
        detail: encodeWorkStartedDetail({ branchName, worktreePath, repoPath }),
      };
      await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, worktreeSourceRef], {
        cwd: repoPath,
        timeout: GIT_CHECKOUT_TIMEOUT,
        signal,
      });
      createdBranch = true;
    }

    logger.info(`Created worktree at ${worktreePath} for PR branch ${branchName}`);

    try {
      // Only include branchName when this action created the branch, so cleanup
      // won't accidentally delete a pre-existing user branch.
      const detail = encodeWorkStartedDetail({
        ...(createdBranch ? { branchName } : {}),
        worktreePath,
        repoPath,
      });
      cancellationState.cleanupActivity = { timestamp: Date.now(), type: 'work-started', detail };
      await this.addActivity(item.id, 'work-started', detail);
    } catch (activityErr) {
      logger.error('Failed to log work-started activity', activityErr);
      void vscode.window.showWarningMessage(
        `DevDocket: Worktree created but failed to log activity — cleanup prompt may not work`,
      );
    }

    await this.runPostWorktreeCommands(worktreePath, progress, signal, cancellationState);

    void vscode.window.showInformationMessage(
      `DevDocket: Created worktree for ${branchName}`,
    );
  }

  private async prCheckoutFlow(
    item: Readonly<WorkItem>,
    repoPath: string,
    branchInfo: PrBranchInfo,
    progress: vscode.Progress<{ message?: string }>,
    signal: AbortSignal,
    cancellationState: FlowCancellationState,
  ): Promise<void> {
    const { branchName, sourceRef, trackingRef } = branchInfo;
    const canProceed = await this.checkDirtyTree(repoPath, signal);
    if (!canProceed) {
      return;
    }

    this.reportStep(progress, cancellationState, 'Checking out branch...', 'checking out branch');

    // Check if the branch already exists locally to pick the right checkout strategy.
    // For fork PRs without a local branch, create from the remote tracking ref.
    // For same-repo PRs without a local branch, create from origin/<branch>.
    // When a fork trackingRef is set and a local branch exists, use a detached checkout
    // to avoid destructively modifying the user's existing branch.
    const hasLocalBranch = await this.localBranchExists(branchName, repoPath, signal);

    // Pre-check: if `git checkout <branch>` would collide with another worktree
    // that already holds the branch, surface a clear error before attempting it.
    // The current worktree (`repoPath`) is excluded — when it's the holder, the
    // branch is already HEAD and `git checkout <branch>` is a successful no-op.
    if (hasLocalBranch && !trackingRef) {
      const conflictingWorktree = await this.findWorktreeHoldingBranch(branchName, repoPath, repoPath, signal);
      if (conflictingWorktree) {
        void vscode.window.showErrorMessage(
          `DevDocket: Branch "${branchName}" is already checked out by the worktree at "${conflictingWorktree}". Use worktree mode instead, or remove the conflicting worktree first.`,
        );
        return;
      }
    }

    let checkoutArgs: string[];
    // Track whether this action created the branch (for safe cleanup later)
    let createdBranch = false;
    if (hasLocalBranch && trackingRef) {
      // Fork PR with existing local branch — use detached checkout to avoid
      // destructively resetting the user's branch.
      checkoutArgs = ['checkout', '--detach', trackingRef];
    } else if (hasLocalBranch) {
      checkoutArgs = ['checkout', branchName];
    } else if (trackingRef) {
      checkoutArgs = ['checkout', '-b', branchName, trackingRef];
      createdBranch = true;
    } else {
      checkoutArgs = ['checkout', '-b', branchName, '--track', sourceRef];
      createdBranch = true;
    }

    await execFileAsync('git', checkoutArgs, { cwd: repoPath, timeout: GIT_CHECKOUT_TIMEOUT, signal });
    logger.info(`Checked out PR branch ${branchName}`);

    try {
      // Only include branchName when this action created the branch, so cleanup
      // won't accidentally delete a pre-existing user branch.
      const detail = encodeWorkStartedDetail({
        ...(createdBranch ? { branchName } : {}),
        repoPath,
      });
      await this.addActivity(item.id, 'work-started', detail);
    } catch (activityErr) {
      logger.error('Failed to log work-started activity', activityErr);
      void vscode.window.showWarningMessage(
        `DevDocket: Branch checked out but failed to log activity — cleanup prompt may not work`,
      );
    }

    void vscode.window.showInformationMessage(
      `DevDocket: Checked out branch ${branchName}`,
    );
  }

  /**
   * Checks if the working tree is dirty and prompts the user for confirmation.
   * Returns true if work can proceed (clean tree or user confirmed).
   */
  private async checkDirtyTree(repoPath: string, signal?: AbortSignal): Promise<boolean> {
    const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
    if (statusOutput.trim()) {
      const answer = await vscode.window.showWarningMessage(
        'Working tree has uncommitted changes. Checkout anyway?',
        { modal: true },
        'Yes',
      );
      if (answer !== 'Yes') {
        return false;
      }
    }
    return true;
  }

  /** Checks whether a local branch with the given name already exists. */
  private async localBranchExists(branchName: string, repoPath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT, signal });
      return true;
    } catch (err) {
      if (this.isAbortError(err)) {
        throw err;
      }
      return false;
    }
  }

  /**
   * Returns the path of a worktree that has {@link branchName} checked out as
   * its branch ref (i.e., would collide with `git worktree add <path> <branch>`
   * or `git checkout <branch>`), or `undefined` if no qualifying worktree holds
   * it. When {@link excludeWorktreePath} is provided, a holder whose path
   * matches it (after path normalisation, case-insensitive on Windows) is
   * ignored — useful for callers like `prCheckoutFlow` where the current
   * worktree being the holder is a no-op rather than a conflict.
   *
   * Uses `git worktree list --porcelain` so detection doesn't rely on parsing
   * localised/version-dependent error strings from a failed git command.
   */
  private async findWorktreeHoldingBranch(
    branchName: string,
    repoPath: string,
    excludeWorktreePath?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        timeout: GIT_METADATA_TIMEOUT,
        signal,
      }));
    } catch (err) {
      if (this.isAbortError(err)) {
        throw err;
      }
      // Pre-check is best-effort — if it fails, fall through and let the actual
      // git operation surface any real error.
      logger.debug(`git worktree list --porcelain failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    const targetRef = `refs/heads/${branchName}`;
    const normalizedExclude = excludeWorktreePath ? path.resolve(excludeWorktreePath) : undefined;
    let currentWorktree: string | undefined;
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('worktree ')) {
        currentWorktree = line.slice('worktree '.length);
      } else if (line === '') {
        currentWorktree = undefined;
      } else if (line === `branch ${targetRef}` && currentWorktree !== undefined) {
        if (normalizedExclude !== undefined && this.pathsEqual(currentWorktree, normalizedExclude)) {
          continue;
        }
        return currentWorktree;
      }
    }
    return undefined;
  }

  /**
   * Compares two filesystem paths for equality after normalisation. Uses
   * case-insensitive comparison on Windows; case-sensitive elsewhere.
   */
  private pathsEqual(a: string, b: string): boolean {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32'
      ? na.toLowerCase() === nb.toLowerCase()
      : na === nb;
  }

  /**
   * Prompts the user to choose between checkout and worktree modes.
   */
  private async promptForWorkMode(): Promise<WorkMode | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Checkout branch', value: 'checkout' as WorkMode },
        { label: 'Create worktree', value: 'worktree' as WorkMode },
      ],
      {
        placeHolder: 'How would you like to work on this?',
        ignoreFocusOut: true,
      },
    );
    return choice?.value;
  }

  private shouldPromptForNames(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>('devdocket.startGitWork.promptForNames', true);
  }

  private async promptForBranchName(proposedBranchName: string, workMode: WorkMode): Promise<string | undefined> {
    const selectedBranchName = await vscode.window.showInputBox({
      title: 'DevDocket: Branch name',
      prompt: workMode === 'worktree'
        ? 'Local branch name to use for the new worktree (created if needed)'
        : 'Local branch name to check out (created if needed)',
      value: proposedBranchName,
      valueSelection: [0, proposedBranchName.length],
      ignoreFocusOut: true,
      validateInput: input => this.validateBranchName(input),
    });
    return selectedBranchName === undefined ? undefined : this.normalizePromptedBranchName(selectedBranchName);
  }

  private async promptForWorktreePath(
    repoPath: string,
    branchName: string,
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
  ): Promise<string | undefined> {
    const defaultWorktreePath = this.getDefaultWorktreePath(repoPath, branchName, item, gitWork);
    const defaultDirName = path.basename(defaultWorktreePath);
    const selectedPath = await vscode.window.showInputBox({
      title: 'DevDocket: Worktree path',
      prompt: 'Filesystem path where the new worktree will be created',
      value: defaultWorktreePath,
      valueSelection: [defaultWorktreePath.length - defaultDirName.length, defaultWorktreePath.length],
      ignoreFocusOut: true,
      validateInput: input => this.validateWorktreePath(input, repoPath),
    });
    return selectedPath?.trim();
  }

  private validateBranchName(input: string): string | undefined {
    const trimmedInput = input.trim();
    const branchName = this.normalizePromptedBranchName(input);
    if (branchName.length === 0) {
      return 'Branch name is required.';
    }
    if (trimmedInput.startsWith('refs/') && !trimmedInput.startsWith('refs/heads/')) {
      return 'Branch name must be a branch ref, not another refs/ namespace.';
    }
    if (!isValidRef(branchName)) {
      return 'Branch name must be a valid git ref (letters, digits, ., _, /, -; no leading -, spaces, .., or control characters).';
    }
    return undefined;
  }

  private normalizePromptedBranchName(input: string): string {
    return this.normalizeBranchName(input.trim());
  }

  private validateWorktreePath(input: string, repoPath: string): string | undefined {
    const trimmedInput = input.trim();
    if (trimmedInput.length === 0) {
      return 'Worktree path is required.';
    }
    if (!path.isAbsolute(trimmedInput)) {
      return 'Worktree path must be absolute.';
    }

    const resolvedPath = path.resolve(trimmedInput);
    const parentPath = path.dirname(resolvedPath);
    if (!fs.existsSync(parentPath)) {
      return `Parent directory "${parentPath}" does not exist.`;
    }
    if (fs.existsSync(resolvedPath)) {
      return `Worktree path "${resolvedPath}" already exists.`;
    }
    if (this.isPathInsideOrEqual(parentPath, repoPath)) {
      return 'Worktree parent directory must not be inside the source repository.';
    }

    return undefined;
  }

  private isPathInsideOrEqual(candidatePath: string, containerPath: string): boolean {
    const relative = path.relative(path.resolve(containerPath), path.resolve(candidatePath));
    return relative === '' || (relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  /**
   * Runs user-configured post-worktree commands.
   */
  private async runPostWorktreeCommands(
    worktreePath: string,
    progress: vscode.Progress<{ message?: string }>,
    signal: AbortSignal,
    cancellationState: FlowCancellationState,
  ): Promise<void> {
    const commands = vscode.workspace.getConfiguration('devDocketStartGitWork')
      .get<{ command: string; args?: string[] }[]>('commands', []);

    for (const cmd of commands) {
      this.reportStep(progress, cancellationState, `Running ${cmd.command}...`, `running ${cmd.command}`);
      const resolvedArgs = (cmd.args ?? []).map(
        arg => arg.replace(/\{path\}/g, worktreePath),
      );
      try {
        await execFileAsync(cmd.command, resolvedArgs, { cwd: worktreePath, timeout: 60_000, signal });
      } catch (cmdErr) {
        if (this.isAbortError(cmdErr)) {
          throw cmdErr;
        }
        const cmdMessage = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
        logger.error(`Post-worktree command failed: ${cmd.command}`, cmdErr);
        void vscode.window.showWarningMessage(
          `DevDocket: Command "${cmd.command}" failed — ${cmdMessage}`,
        );
      }
    }
  }

  private async rollbackCreatedBranch(branchName: string, baseBranch: string, repoPath: string): Promise<void> {
    try {
      await execFileAsync('git', ['branch', '-d', '--', branchName], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT });
      return;
    } catch (deleteErr) {
      const branchRef = `refs/heads/${branchName}`;
      const [{ stdout: branchHead }, { stdout: baseHead }] = await Promise.all([
        execFileAsync('git', ['rev-parse', '--verify', branchRef], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT }),
        execFileAsync('git', ['rev-parse', '--verify', baseBranch], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT }),
      ]);
      if (branchHead.trim() === baseHead.trim()) {
        await execFileAsync('git', ['branch', '-D', '--', branchName], { cwd: repoPath, timeout: GIT_METADATA_TIMEOUT });
        return;
      }
      throw deleteErr;
    }
  }

  private async addActivity(itemId: string, type: ActivityType, detail?: string): Promise<void> {
    await vscode.commands.executeCommand('devdocket.addActivity', itemId, type, detail);
  }

  private reportStep(
    progress: vscode.Progress<{ message?: string }>,
    cancellationState: FlowCancellationState,
    message: string,
    step: string,
  ): void {
    cancellationState.currentStep = step;
    progress.report({ message });
  }

  private isAbortError(err: unknown): boolean {
    const abortError = err as { name?: string; code?: string };
    return abortError?.name === 'AbortError' || abortError?.code === 'ABORT_ERR';
  }

  private async handleFlowCancellation(
    item: Readonly<WorkItem>,
    err: unknown,
    cancellationState: FlowCancellationState,
  ): Promise<boolean> {
    if (!this.isAbortError(err)) {
      return false;
    }

    const detail = `Start Git Work cancelled during ${cancellationState.currentStep}.`;
    try {
      await this.addActivity(item.id, 'action-executed', detail);
    } catch (activityErr) {
      logger.warn('Failed to log cancellation activity', activityErr);
    }

    if (cancellationState.cleanupActivity) {
      const cleanupInfo = decodeWorkStartedDetail(cancellationState.cleanupActivity.detail);
      const hasWorktree = !!cleanupInfo?.worktreePath;
      const cleanupTarget = hasWorktree
        ? 'The created worktree may need cleanup.'
        : 'A partially created branch may need cleanup.';
      const cleanupAction = hasWorktree ? 'Remove worktree' : 'Clean up';
      const choice = await vscode.window.showWarningMessage(
        `DevDocket: ${detail} ${cleanupTarget}`,
        cleanupAction,
      );
      if (choice === cleanupAction) {
        await promptGitCleanup(
          {
            ...item,
            activityLog: [...(item.activityLog ?? []), cancellationState.cleanupActivity],
          },
          async (itemId, type, activityDetail) => this.addActivity(itemId, type, activityDetail),
        );
      }
      return true;
    }

    void vscode.window.showInformationMessage(`DevDocket: ${detail}`);
    return true;
  }

  private normalizeBranchName(ref: string): string {
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  }

  private formatGitError(error: unknown): string {
    const gitError = error as { stderr?: string; stdout?: string; message?: string };
    const detail = [gitError.stderr, gitError.stdout, gitError.message]
      .map(value => value?.trim())
      .find(Boolean);
    return detail ?? 'Check your network connection, permissions, and whether the branch still exists.';
  }

  private getDefaultWorktreePath(
    repoPath: string,
    ref: string,
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
  ): string {
    return path.join(path.dirname(repoPath), this.toWorktreeDirName(repoPath, ref, item, gitWork));
  }

  private toWorktreeDirName(
    repoPath: string,
    ref: string,
    item: Readonly<WorkItem>,
    gitWork: ResolvedGitWork,
  ): string {
    const itemNumber = this.workItemNumber(item.externalId ?? item.id);
    if (itemNumber) {
      const repoBaseName = this.sourceRepoBaseName(gitWork, repoPath);
      return `${repoBaseName}-${gitWork.kind}-${itemNumber}`;
    }

    const repoBaseName = path.basename(repoPath);
    const refSuffix = this.toWorktreePathSuffix(ref);
    const identitySuffix = this.worktreeFallbackIdentity(item);
    return identitySuffix ? `${repoBaseName}-${refSuffix}-${identitySuffix}` : `${repoBaseName}-${refSuffix}`;
  }

  private worktreeFallbackIdentity(item: Readonly<WorkItem>): string | undefined {
    const identity = [item.providerId, item.externalId ?? item.id].filter(Boolean).join(':');
    return identity ? this.shortStableHash(identity) : undefined;
  }

  private shortStableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (const char of value) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(6, '0').slice(0, 6);
  }

  private workItemNumber(externalId: string | undefined): string | undefined {
    return externalId?.trim().match(/(?:#|!)(\d+)$/)?.[1]
      ?? externalId?.trim().match(/(?:^|[\/\\_-])(\d+)$/)?.[1];
  }

  private sourceRepoBaseName(gitWork: ResolvedGitWork, repoPath: string): string {
    const candidate = this.repoBaseNameFromLabel(gitWork.repoLabel)
      ?? this.repoBaseNameFromCloneUrl(gitWork.cloneUrl)
      ?? path.basename(repoPath);
    return this.toWorktreePathSuffix(candidate);
  }

  private repoBaseNameFromLabel(repoLabel: string | undefined): string | undefined {
    return repoLabel?.split(/[\\/]/).filter(Boolean).at(-1);
  }

  private repoBaseNameFromCloneUrl(cloneUrl: string): string | undefined {
    try {
      return new URL(cloneUrl).pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '');
    } catch {
      return cloneUrl.match(/^git@[^:]+:(.+)$/)?.[1].split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '');
    }
  }

  private toWorktreePathSuffix(ref: string): string {
    return ref.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
  }

  private toRemoteName(cloneUrl: string, repoLabel?: string): string {
    const candidate = this.ownerLikeSegmentFromCloneUrl(cloneUrl) ?? repoLabel ?? cloneUrl;
    const suffix = candidate.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
    const remoteName = `devdocket-fork-${suffix}`;
    return isValidRef(remoteName) ? remoteName : 'devdocket-fork-source';
  }

  private ownerLikeSegmentFromCloneUrl(cloneUrl: string): string | undefined {
    if (cloneUrl.startsWith('https://')) {
      try {
        const segments = new URL(cloneUrl).pathname.split('/').filter(Boolean);
        if (segments.some(segment => segment.toLowerCase() === '_git')) {
          return undefined;
        }
        return segments.length >= 2 ? segments[segments.length - 2] : undefined;
      } catch {
        return undefined;
      }
    }

    const gitPath = cloneUrl.match(/^git@[^:]+:(.+)$/)?.[1];
    if (!gitPath) {
      return undefined;
    }
    const segments = gitPath.split('/').filter(Boolean);
    return segments.length >= 2 ? segments[segments.length - 2] : undefined;
  }

  /**
   * Prompts the user for a local repo path, offering cached and open workspace repositories first.
   * Caches the selection on success. Does not cache on cancel, empty input, or invalid path.
   */
  private async promptForRepoPath(repoKey: string): Promise<string | undefined> {
    const cacheKey = `repoPath:${repoKey}`;
    const cachedPath = this.globalState.get<string>(cacheKey)?.trim();
    let validationMessage: string | undefined;

    while (true) {
      const selected = await vscode.window.showQuickPick(
        this.createRepoPathPicks(cachedPath),
        {
          placeHolder: validationMessage ?? `Select the local repository for ${repoKey}`,
          ignoreFocusOut: true,
        },
      );

      if (!selected) {
        return undefined;
      }

      const selectedPath = await this.resolveRepoPathPick(selected, cachedPath, repoKey);
      if (selectedPath === undefined) {
        return undefined;
      }

      const validationError = this.validateRepoPath(selectedPath);
      if (validationError) {
        validationMessage = validationError;
        continue;
      }

      await this.globalState.update(cacheKey, selectedPath);
      return selectedPath;
    }
  }

  private createRepoPathPicks(cachedPath: string | undefined): RepoPathPick[] {
    const picks: RepoPathPick[] = [];
    const addRepoPath = (repoPath: string, description: string) => {
      if (picks.some(pick => pick.pickKind === 'repo' && this.pathsEqual(pick.repoPath, repoPath))) {
        return;
      }
      picks.push({ label: repoPath, description, pickKind: 'repo', repoPath });
    };

    if (cachedPath) {
      addRepoPath(cachedPath, 'Last used');
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderPath = folder.uri.fsPath;
      if (fs.existsSync(path.join(folderPath, '.git'))) {
        addRepoPath(folderPath, 'Open workspace folder');
      }
    }

    picks.push({ label: 'Enter path manually…', description: 'Type or paste a repository path', pickKind: 'paste' });
    picks.push({ label: 'Browse…', description: 'Choose a repository folder', pickKind: 'browse' });
    return picks;
  }

  private async resolveRepoPathPick(
    selected: RepoPathPick,
    cachedPath: string | undefined,
    repoKey: string,
  ): Promise<string | undefined> {
    if (selected.pickKind === 'repo') {
      return selected.repoPath.trim();
    }

    if (selected.pickKind === 'paste') {
      const pastedPath = await vscode.window.showInputBox({
        prompt: `Enter the local path to the git repository for ${repoKey}`,
        value: cachedPath ?? '',
        ignoreFocusOut: true,
      });
      return pastedPath?.trim();
    }

    const selectedFolders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Repository Folder',
      title: `Select local repository for ${repoKey}`,
    });
    return selectedFolders?.[0]?.fsPath.trim();
  }

  private validateRepoPath(repoPath: string): string | undefined {
    if (!repoPath) {
      return 'Choose a repository folder or paste an absolute path.';
    }
    if (!path.isAbsolute(repoPath)) {
      return `"${repoPath}" is not an absolute path. Choose a repository folder.`;
    }
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      return `"${repoPath}" does not contain git metadata. Choose a repository folder.`;
    }
    return undefined;
  }

  /**
   * Prompts the user for a base branch, pre-filling the last-used branch for this repo.
   * Caches the selection on success. Does not cache on cancel or empty input.
   */
  private async promptForBaseBranch(repoKey: string): Promise<string | undefined> {
    const cacheKey = `baseBranch:${repoKey}`;
    const cachedBranch = this.globalState.get<string>(cacheKey);

    const selectedBranch = await vscode.window.showInputBox({
      prompt: `Enter the base branch for ${repoKey}`,
      value: cachedBranch ?? '',
      ignoreFocusOut: true,
    });

    if (selectedBranch === undefined) {
      return undefined;
    }

    const trimmedBranch = selectedBranch.trim();
    if (!trimmedBranch) {
      void vscode.window.showErrorMessage('DevDocket: No base branch provided.');
      return undefined;
    }

    if (!isValidRef(trimmedBranch)) {
      void vscode.window.showErrorMessage('DevDocket: Base branch name contains invalid characters.');
      return undefined;
    }

    await this.globalState.update(cacheKey, trimmedBranch);
    return trimmedBranch;
  }
}

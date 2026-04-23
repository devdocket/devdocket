import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import { WorkItemState, type WorkItem, type DevDocketAction } from '@devdocket/shared';

const execFileAsync = promisify(execFile);

interface ParsedExternalId {
  repoKey: string;
  itemNumber: string;
}

const SUPPORTED_PROVIDERS = [
  'github',
  'ado-work-items',
  'github-my-prs',
  'github-pr-reviews',
  'ado-pr-reviews',
];

const PR_PROVIDERS = ['github-my-prs', 'github-pr-reviews', 'ado-pr-reviews'];

type WorkMode = 'checkout' | 'worktree';

interface GitHubPrHead {
  ref: string;
  repo: {
    full_name: string;
    clone_url: string;
  };
}

interface GitHubPrResponse {
  head: GitHubPrHead;
  base: {
    repo: {
      full_name: string;
    };
  };
}

interface AdoPrResponse {
  sourceRefName: string;
}

/**
 * DevDocket action that bootstraps a development environment for a work item.
 *
 * Supports items from GitHub and Azure DevOps providers (both issues and PRs).
 * When executed on an issue it creates a new branch and checks out or creates a worktree.
 * When executed on a PR it fetches the existing PR branch instead of creating one.
 *
 * Only available for items in the `InProgress` state from supported providers.
 */
export class StartWorkAction implements DevDocketAction {
  readonly id = 'startGitWork';
  readonly label = 'Start Git Work (Branch + Worktree)';

  private readonly globalState: vscode.Memento;

  constructor(globalState: vscode.Memento) {
    this.globalState = globalState;
  }

  canRun(item: Readonly<WorkItem>): boolean {
    return item.state === WorkItemState.InProgress && SUPPORTED_PROVIDERS.includes(item.providerId ?? '');
  }

  async run(item: Readonly<WorkItem>): Promise<void> {
    const parsed = this.parseExternalId(item.externalId);
    if (!parsed) {
      void vscode.window.showErrorMessage('Could not determine issue number.');
      return;
    }

    const isPr = PR_PROVIDERS.includes(item.providerId ?? '');

    const repoPath = await this.promptForRepoPath(parsed.repoKey);
    if (!repoPath) {
      return;
    }

    if (isPr) {
      await this.runPrFlow(item, parsed, repoPath);
    } else {
      await this.runIssueFlow(item, parsed, repoPath);
    }
  }

  private async runIssueFlow(
    item: Readonly<WorkItem>,
    parsed: ParsedExternalId,
    repoPath: string,
  ): Promise<void> {
    const branchName = `issue${parsed.itemNumber}`;

    const baseBranch = await this.promptForBaseBranch(parsed.repoKey);
    if (!baseBranch) {
      return;
    }

    const workMode = await this.promptForWorkMode();
    if (!workMode) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting git work for issue ${parsed.itemNumber}`,
          cancellable: false,
        },
        async (progress) => {
          if (workMode === 'worktree') {
            await this.issueWorktreeFlow(item, parsed, repoPath, branchName, baseBranch, progress);
          } else {
            await this.issueCheckoutFlow(item, parsed, repoPath, branchName, baseBranch, progress);
          }
        },
      );
    } catch (err: unknown) {
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`DevDocket: Failed to start work — ${message}`);
    }
  }

  private async issueWorktreeFlow(
    item: Readonly<WorkItem>,
    parsed: ParsedExternalId,
    repoPath: string,
    branchName: string,
    baseBranch: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const repoBaseName = path.basename(repoPath);
    const worktreeDirName = `${repoBaseName}-issue${parsed.itemNumber}`;
    const worktreePath = path.join(path.dirname(repoPath), worktreeDirName);

    if (fs.existsSync(worktreePath)) {
      void vscode.window.showErrorMessage(`DevDocket: Directory "${worktreePath}" already exists.`);
      return;
    }

    progress.report({ message: 'Creating branch...' });

    const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath, timeout: 30_000 });
    if (branchList.trim()) {
      void vscode.window.showErrorMessage(`DevDocket: Branch "${branchName}" already exists.`);
      return;
    }

    await execFileAsync('git', ['branch', branchName, baseBranch], { cwd: repoPath, timeout: 30_000 });
    logger.info(`Starting work: creating branch ${branchName}`);

    progress.report({ message: 'Creating worktree...' });

    try {
      await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
        cwd: repoPath,
        timeout: 30_000,
      });
    } catch (worktreeErr) {
      try {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath, timeout: 30_000 });
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

    try {
      const detail = JSON.stringify({ branchName, worktreePath, repoPath });
      await vscode.commands.executeCommand('devdocket.addActivity', item.id, 'work-started', detail);
    } catch (activityErr) {
      logger.error('Failed to log work-started activity', activityErr);
      void vscode.window.showWarningMessage(
        `DevDocket: Worktree created but failed to log activity — cleanup prompt may not work`,
      );
    }

    await this.runPostWorktreeCommands(worktreePath, progress);

    void vscode.window.showInformationMessage(
      `DevDocket: Created worktree for ${branchName}`,
    );
  }

  private async issueCheckoutFlow(
    item: Readonly<WorkItem>,
    parsed: ParsedExternalId,
    repoPath: string,
    branchName: string,
    baseBranch: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const canProceed = await this.checkDirtyTree(repoPath);
    if (!canProceed) {
      return;
    }

    progress.report({ message: 'Creating and checking out branch...' });

    await execFileAsync('git', ['checkout', '-b', branchName, baseBranch], { cwd: repoPath, timeout: 30_000 });
    logger.info(`Starting work: checked out new branch ${branchName}`);

    try {
      const detail = JSON.stringify({ branchName, repoPath });
      await vscode.commands.executeCommand('devdocket.addActivity', item.id, 'work-started', detail);
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
    parsed: ParsedExternalId,
    repoPath: string,
  ): Promise<void> {
    const workMode = await this.promptForWorkMode();
    if (!workMode) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting git work for PR #${parsed.itemNumber}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Fetching PR branch...' });

          const isGitHubPr = item.providerId === 'github-my-prs' || item.providerId === 'github-pr-reviews';
          const branchName = isGitHubPr
            ? await this.fetchGitHubPrBranch(parsed, repoPath)
            : await this.fetchAdoPrBranch(parsed, repoPath);

          if (!branchName) {
            return;
          }

          if (workMode === 'worktree') {
            await this.prWorktreeFlow(item, parsed, repoPath, branchName, progress);
          } else {
            await this.prCheckoutFlow(item, repoPath, branchName, progress);
          }
        },
      );
    } catch (err: unknown) {
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`DevDocket: Failed to start work — ${message}`);
    }
  }

  /**
   * Fetches the branch name for a GitHub PR and ensures it is available locally.
   * Handles fork detection — adds a remote for the fork owner if needed.
   */
  private async fetchGitHubPrBranch(parsed: ParsedExternalId, repoPath: string): Promise<string | undefined> {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    if (!session) {
      void vscode.window.showErrorMessage('DevDocket: GitHub authentication required.');
      return undefined;
    }

    const [owner, repo] = parsed.repoKey.split('/');
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${parsed.itemNumber}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        void vscode.window.showErrorMessage(`DevDocket: Could not find PR #${parsed.itemNumber}`);
      } else {
        void vscode.window.showErrorMessage(`DevDocket: GitHub API error (${response.status})`);
      }
      return undefined;
    }

    const pr = await response.json() as GitHubPrResponse;
    const branchName = pr.head.ref;
    const isFork = pr.head.repo.full_name !== pr.base.repo.full_name;

    if (isFork) {
      const forkOwner = pr.head.repo.full_name.split('/')[0];
      const cloneUrl = pr.head.repo.clone_url;

      // Add remote if it doesn't already exist
      try {
        await execFileAsync('git', ['remote', 'add', forkOwner, cloneUrl], { cwd: repoPath, timeout: 30_000 });
      } catch {
        // Remote already exists — that's fine
      }

      await execFileAsync('git', ['fetch', forkOwner, branchName], { cwd: repoPath, timeout: 30_000 });
    } else {
      await execFileAsync('git', ['fetch', 'origin', branchName], { cwd: repoPath, timeout: 30_000 });
    }

    return branchName;
  }

  /**
   * Fetches the branch name for an ADO PR.
   * Strips the `refs/heads/` prefix from `sourceRefName`.
   */
  private async fetchAdoPrBranch(parsed: ParsedExternalId, repoPath: string): Promise<string | undefined> {
    const session = await vscode.authentication.getSession(
      'microsoft',
      ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      { createIfNone: true },
    );
    if (!session) {
      void vscode.window.showErrorMessage('DevDocket: Microsoft authentication required.');
      return undefined;
    }

    // ADO PR externalId format: org/project/repo/id
    const parts = parsed.repoKey.split('/');
    const org = parts[0];
    const project = parts[1];
    const adoRepo = parts[2];
    const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${adoRepo}/pullrequests/${parsed.itemNumber}?api-version=7.1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        void vscode.window.showErrorMessage(`DevDocket: Could not find PR #${parsed.itemNumber}`);
      } else {
        void vscode.window.showErrorMessage(`DevDocket: ADO API error (${response.status})`);
      }
      return undefined;
    }

    const pr = await response.json() as AdoPrResponse;
    const branchName = pr.sourceRefName.replace(/^refs\/heads\//, '');

    await execFileAsync('git', ['fetch', 'origin', branchName], { cwd: repoPath, timeout: 30_000 });

    return branchName;
  }

  private async prWorktreeFlow(
    item: Readonly<WorkItem>,
    parsed: ParsedExternalId,
    repoPath: string,
    branchName: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const repoBaseName = path.basename(repoPath);
    const worktreeDirName = `${repoBaseName}-pr${parsed.itemNumber}`;
    const worktreePath = path.join(path.dirname(repoPath), worktreeDirName);

    if (fs.existsSync(worktreePath)) {
      void vscode.window.showErrorMessage(`DevDocket: Directory "${worktreePath}" already exists.`);
      return;
    }

    progress.report({ message: 'Creating worktree...' });

    await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
      cwd: repoPath,
      timeout: 30_000,
    });

    logger.info(`Created worktree at ${worktreePath} for PR branch ${branchName}`);

    try {
      const detail = JSON.stringify({ branchName, worktreePath, repoPath });
      await vscode.commands.executeCommand('devdocket.addActivity', item.id, 'work-started', detail);
    } catch (activityErr) {
      logger.error('Failed to log work-started activity', activityErr);
      void vscode.window.showWarningMessage(
        `DevDocket: Worktree created but failed to log activity — cleanup prompt may not work`,
      );
    }

    await this.runPostWorktreeCommands(worktreePath, progress);

    void vscode.window.showInformationMessage(
      `DevDocket: Created worktree for ${branchName}`,
    );
  }

  private async prCheckoutFlow(
    item: Readonly<WorkItem>,
    repoPath: string,
    branchName: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const canProceed = await this.checkDirtyTree(repoPath);
    if (!canProceed) {
      return;
    }

    progress.report({ message: 'Checking out branch...' });

    await execFileAsync('git', ['checkout', branchName], { cwd: repoPath, timeout: 30_000 });
    logger.info(`Checked out PR branch ${branchName}`);

    try {
      const detail = JSON.stringify({ branchName, repoPath });
      await vscode.commands.executeCommand('devdocket.addActivity', item.id, 'work-started', detail);
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
  private async checkDirtyTree(repoPath: string): Promise<boolean> {
    const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 30_000 });
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

  /**
   * Runs user-configured post-worktree commands.
   */
  private async runPostWorktreeCommands(
    worktreePath: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const commands = vscode.workspace.getConfiguration('devdocketStartGitWork')
      .get<{ command: string; args?: string[] }[]>('commands', []);

    for (const cmd of commands) {
      progress.report({ message: `Running ${cmd.command}...` });
      const resolvedArgs = (cmd.args ?? []).map(
        arg => arg.replace(/\{path\}/g, worktreePath),
      );
      try {
        await execFileAsync(cmd.command, resolvedArgs, { cwd: worktreePath, timeout: 60_000 });
      } catch (cmdErr) {
        const cmdMessage = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
        logger.error(`Post-worktree command failed: ${cmd.command}`, cmdErr);
        void vscode.window.showWarningMessage(
          `DevDocket: Command "${cmd.command}" failed — ${cmdMessage}`,
        );
      }
    }
  }

  /**
   * Parses the externalId into repoKey and itemNumber.
   * Supports two formats:
   *   GitHub:  "owner/repo#123"       → repoKey="owner/repo", itemNumber="123"
   *   ADO:    "org/project/123"       → repoKey="org/project", itemNumber="123"
   */
  private parseExternalId(externalId: string | undefined): ParsedExternalId | undefined {
    if (!externalId) {
      return undefined;
    }

    // Try GitHub format first (has #)
    const ghMatch = externalId.match(/^(.+?)#(\d+)$/);
    if (ghMatch) {
      return { repoKey: ghMatch[1], itemNumber: ghMatch[2] };
    }

    // Fall back to ADO format: last /-separated segment is numeric
    const adoMatch = externalId.match(/^(.+)\/(\d+)$/);
    if (adoMatch) {
      return { repoKey: adoMatch[1], itemNumber: adoMatch[2] };
    }

    return undefined;
  }

  /**
   * Prompts the user for a local repo path, pre-filling the last-used path for this repo.
   * Caches the selection on success. Does not cache on cancel, empty input, or invalid path.
   */
  private async promptForRepoPath(repoKey: string): Promise<string | undefined> {
    const cacheKey = `repoPath:${repoKey}`;
    const cachedPath = this.globalState.get<string>(cacheKey);

    const selectedPath = await vscode.window.showInputBox({
      prompt: `Enter the local path to the git repository for ${repoKey}`,
      value: cachedPath ?? '',
      ignoreFocusOut: true,
    });

    if (selectedPath === undefined) {
      return undefined;
    }

    const trimmedPath = selectedPath.trim();
    if (!trimmedPath) {
      void vscode.window.showErrorMessage('DevDocket: No repository path provided.');
      return undefined;
    }

    const gitPath = path.join(trimmedPath, '.git');
    if (!fs.existsSync(gitPath)) {
      void vscode.window.showErrorMessage(`DevDocket: "${trimmedPath}" is not a git repository.`);
      return undefined;
    }

    await this.globalState.update(cacheKey, trimmedPath);
    return trimmedPath;
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

    await this.globalState.update(cacheKey, trimmedBranch);
    return trimmedBranch;
  }
}

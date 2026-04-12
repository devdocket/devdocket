import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

// Re-declared to match core API contract — separate extension cannot import core types directly
interface WorkItem {
  id: string;
  title: string;
  notes?: string;
  state: string;
  providerId?: string;
  externalId?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

// Re-declared to match core API contract — separate extension cannot import core types directly
interface WorkCenterAction {
  readonly id: string;
  readonly label: string;
  canRun(item: WorkItem): boolean;
  run(item: WorkItem): Promise<void>;
}

interface ParsedExternalId {
  repoKey: string;
  issueNumber: string;
}

/**
 * WorkCenter action that bootstraps a development environment for a GitHub issue.
 *
 * When executed on a work item originating from the GitHub provider, it:
 * 1. Prompts the user for the local repository path (with cached defaults).
 * 2. Creates a feature branch from `origin/dev` (falling back to `origin/main` or `HEAD`).
 * 3. Creates a git worktree at a sibling directory of the repository.
 * 4. Opens the worktree in a new VS Code window.
 *
 * Only available for items in the `InProgress` state from the `github` provider.
 */
export class StartWorkAction implements WorkCenterAction {
  readonly id = 'github.startWork';
  readonly label = 'Start Work (Branch + Worktree)';

  private readonly globalState: vscode.Memento;

  constructor(globalState: vscode.Memento) {
    this.globalState = globalState;
  }

  /**
   * Returns `true` when the item is an in-progress GitHub issue.
   * @param item - The work item to evaluate.
   * @returns Whether the action is applicable.
   */
  canRun(item: WorkItem): boolean {
    return item.providerId === 'github' && item.state === 'InProgress';
  }

  /**
   * Creates a branch and worktree for the given work item, then opens it in a new window.
   * Errors are reported via VS Code notification messages rather than thrown.
   * @param item - The work item to start working on.
   */
  async run(item: WorkItem): Promise<void> {
    const parsed = this.parseExternalId(item.externalId);
    if (!parsed) {
      void vscode.window.showErrorMessage('Could not determine issue number.');
      return;
    }

    const branchName = `issue${parsed.issueNumber}`;

    const repoPath = await this.promptForRepoPath(parsed.repoKey);
    if (!repoPath) {
      return;
    }

    const baseBranch = await this.promptForBaseBranch(parsed.repoKey);
    if (!baseBranch) {
      return;
    }

    try {
      // Check if branch already exists
      const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath });
      if (branchList.trim()) {
        void vscode.window.showErrorMessage(`WorkCenter: Branch "${branchName}" already exists.`);
        return;
      }

      await execFileAsync('git', ['branch', branchName, baseBranch], { cwd: repoPath });
      logger.info(`Starting work: creating branch ${branchName}`);

      const repoBaseName = path.basename(repoPath);
      const worktreeDirName = `${repoBaseName}-issue${parsed.issueNumber}`;
      const worktreePath = path.join(path.dirname(repoPath), worktreeDirName);

      // Check if worktree directory already exists
      if (fs.existsSync(worktreePath)) {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath });
        void vscode.window.showErrorMessage(`WorkCenter: Directory "${worktreePath}" already exists.`);
        return;
      }

      try {
        await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
          cwd: repoPath,
        });
      } catch (worktreeErr) {
        // Rollback: delete the branch we just created
        try {
          await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath });
        } catch (rollbackErr) {
          const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          void vscode.window.showWarningMessage(`WorkCenter: Failed to delete branch during rollback — ${rollbackMessage}`);
        }

        const errMsg = worktreeErr instanceof Error ? worktreeErr.message : String(worktreeErr);
        const errStderr = (worktreeErr as any)?.stderr ?? '';
        if (errMsg.includes('already exists') || errStderr.includes('already exists')) {
          vscode.window.showErrorMessage(`WorkCenter: Directory "${worktreePath}" already exists.`);
          return;
        }
        throw worktreeErr;
      }

      logger.info(`Created worktree at ${worktreePath}`);

      // Run user-configured post-worktree commands
      const commands = vscode.workspace.getConfiguration('workcenterGithub')
        .get<{ command: string; args?: string[] }[]>('startWork.commands', []);

      for (const cmd of commands) {
        const resolvedArgs = (cmd.args ?? []).map(
          arg => arg.replace(/\{path\}/g, worktreePath),
        );
        try {
          await execFileAsync(cmd.command, resolvedArgs, { shell: true });
        } catch (cmdErr) {
          const cmdMessage = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
          logger.error(`Post-worktree command failed: ${cmd.command}`, cmdErr);
          void vscode.window.showWarningMessage(
            `WorkCenter: Command "${cmd.command}" failed — ${cmdMessage}`,
          );
        }
      }

      void vscode.window.showInformationMessage(
        `WorkCenter: Created worktree for ${branchName}`,
      );
    } catch (err: unknown) {
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`WorkCenter: Failed to start work — ${message}`);
    }
  }

  /**
   * Parses the externalId format "owner/repo#123" into its components.
   */
  private parseExternalId(externalId: string | undefined): ParsedExternalId | undefined {
    if (!externalId) {
      return undefined;
    }
    const match = externalId.match(/^(.+?)#(\d+)$/);
    if (!match) {
      return undefined;
    }
    return { repoKey: match[1], issueNumber: match[2] };
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
      void vscode.window.showErrorMessage('WorkCenter: No repository path provided.');
      return undefined;
    }

    const gitPath = path.join(trimmedPath, '.git');
    if (!fs.existsSync(gitPath)) {
      void vscode.window.showErrorMessage(`WorkCenter: "${trimmedPath}" is not a git repository.`);
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
      void vscode.window.showErrorMessage('WorkCenter: No base branch provided.');
      return undefined;
    }

    await this.globalState.update(cacheKey, trimmedBranch);
    return trimmedBranch;
  }
}

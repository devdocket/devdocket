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
  group?: string;
  sortOrder?: number;
  createdAt: number;
  updatedAt: number;
}

// Re-declared to match core API contract — separate extension cannot import core types directly
interface DevDocketAction {
  readonly id: string;
  readonly label: string;
  canRun(item: Readonly<WorkItem>): boolean;
  run(item: Readonly<WorkItem>): Promise<void>;
}

interface ParsedExternalId {
  repoKey: string;
  itemNumber: string;
}

const SUPPORTED_PROVIDERS = ['github', 'ado-work-items'];

/**
 * DevDocket action that bootstraps a development environment for a work item.
 *
 * Supports items from both GitHub and Azure DevOps providers.
 * When executed on a work item it:
 * 1. Prompts the user for the local repository path (with cached defaults).
 * 2. Prompts for a base branch (with cached defaults).
 * 3. Creates a feature branch named `issue{num}`.
 * 4. Creates a git worktree at a sibling directory of the repository.
 * 5. Runs any user-configured post-worktree commands.
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
    return item.state === 'InProgress' && SUPPORTED_PROVIDERS.includes(item.providerId ?? '');
  }

  async run(item: Readonly<WorkItem>): Promise<void> {
    const parsed = this.parseExternalId(item.externalId);
    if (!parsed) {
      void vscode.window.showErrorMessage('Could not determine issue number.');
      return;
    }

    const branchName = `issue${parsed.itemNumber}`;

    const repoPath = await this.promptForRepoPath(parsed.repoKey);
    if (!repoPath) {
      return;
    }

    const baseBranch = await this.promptForBaseBranch(parsed.repoKey);
    if (!baseBranch) {
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
          const repoBaseName = path.basename(repoPath);
          const worktreeDirName = `${repoBaseName}-issue${parsed.itemNumber}`;
          const worktreePath = path.join(path.dirname(repoPath), worktreeDirName);

          // Fail fast if worktree directory already exists (before creating branch)
          if (fs.existsSync(worktreePath)) {
            void vscode.window.showErrorMessage(`DevDocket: Directory "${worktreePath}" already exists.`);
            return;
          }

          progress.report({ message: 'Creating branch...' });

          // Check if branch already exists
          const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath });
          if (branchList.trim()) {
            void vscode.window.showErrorMessage(`DevDocket: Branch "${branchName}" already exists.`);
            return;
          }

          await execFileAsync('git', ['branch', branchName, baseBranch], { cwd: repoPath });
          logger.info(`Starting work: creating branch ${branchName}`);

          progress.report({ message: 'Creating worktree...' });

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

          // Log branch and worktree info to the work item's activity log
          try {
            const detail = JSON.stringify({ branchName, worktreePath, repoPath });
            await vscode.commands.executeCommand('devdocket.addActivity', item.id, 'work-started', detail);
          } catch (activityErr) {
            logger.error('Failed to log work-started activity', activityErr);
            void vscode.window.showWarningMessage(
              `DevDocket: Worktree created but failed to log activity — cleanup prompt may not work`,
            );
          }

          // Run user-configured post-worktree commands
          const commands = vscode.workspace.getConfiguration('devdocketStartGitWork')
            .get<{ command: string; args?: string[] }[]>('commands', []);

          for (const cmd of commands) {
            progress.report({ message: `Running ${cmd.command}...` });
            const resolvedArgs = (cmd.args ?? []).map(
              arg => arg.replace(/\{path\}/g, worktreePath),
            );
            try {
              await execFileAsync(cmd.command, resolvedArgs, { cwd: worktreePath });
            } catch (cmdErr) {
              const cmdMessage = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
              logger.error(`Post-worktree command failed: ${cmd.command}`, cmdErr);
              void vscode.window.showWarningMessage(
                `DevDocket: Command "${cmd.command}" failed — ${cmdMessage}`,
              );
            }
          }

          void vscode.window.showInformationMessage(
            `DevDocket: Created worktree for ${branchName}`,
          );
        },
      );
    } catch (err: unknown) {
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`DevDocket: Failed to start work — ${message}`);
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

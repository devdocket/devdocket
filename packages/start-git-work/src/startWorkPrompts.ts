import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkItem } from '@devdocket/shared';
import { isValidRef, normalizeBranchName, pathsEqual } from './gitOps';
import { getDefaultWorktreePath, validateWorktreePath, type WorktreePathGitWork } from './worktreePathResolver';

export type WorkMode = 'checkout' | 'worktree';

type RepoPathPick = vscode.QuickPickItem & (
  | { pickKind: 'repo'; repoPath: string }
  | { pickKind: 'paste' }
  | { pickKind: 'browse' }
);

type ProgressTask<T> = (
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
) => Thenable<T>;

export class StartWorkPrompts {
  constructor(private readonly globalState: vscode.Memento) {}

  async withIssueProgress<T>(task: ProgressTask<T>): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Starting git work for issue',
        cancellable: true,
      },
      task,
    );
  }

  async withPrProgress<T>(task: ProgressTask<T>): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Starting git work for PR',
        cancellable: true,
      },
      task,
    );
  }

  /**
   * Prompts the user for a local repo path, offering cached and open workspace repositories first.
   * Caches the selection on success. Does not cache on cancel, empty input, or invalid path.
   */
  async promptForRepoPath(repoKey: string): Promise<string | undefined> {
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

  /**
   * Prompts the user for a base branch, pre-filling the last-used branch for this repo.
   * Caches the selection on success. Does not cache on cancel or empty input.
   */
  async promptForBaseBranch(repoKey: string): Promise<string | undefined> {
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

  /**
   * Prompts the user to choose between checkout and worktree modes.
   */
  async promptForWorkMode(): Promise<WorkMode | undefined> {
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

  shouldPromptForNames(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>('devdocket.startGitWork.promptForNames', true);
  }

  async promptForBranchName(proposedBranchName: string, workMode: WorkMode): Promise<string | undefined> {
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

  async promptForWorktreePath(
    repoPath: string,
    branchName: string,
    item: Readonly<WorkItem>,
    gitWork: WorktreePathGitWork,
  ): Promise<string | undefined> {
    const defaultWorktreePath = getDefaultWorktreePath(repoPath, branchName, item, gitWork);
    const defaultDirName = path.basename(defaultWorktreePath);
    const selectedPath = await vscode.window.showInputBox({
      title: 'DevDocket: Worktree path',
      prompt: 'Filesystem path where the new worktree will be created',
      value: defaultWorktreePath,
      valueSelection: [defaultWorktreePath.length - defaultDirName.length, defaultWorktreePath.length],
      ignoreFocusOut: true,
      validateInput: input => validateWorktreePath(input, repoPath),
    });
    return selectedPath?.trim();
  }

  private createRepoPathPicks(cachedPath: string | undefined): RepoPathPick[] {
    const picks: RepoPathPick[] = [];
    const addRepoPath = (repoPath: string, description: string) => {
      if (picks.some(pick => pick.pickKind === 'repo' && pathsEqual(pick.repoPath, repoPath))) {
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
    return normalizeBranchName(input.trim());
  }
}

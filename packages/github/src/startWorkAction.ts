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

export class StartWorkAction implements WorkCenterAction {
  readonly id = 'github.startWork';
  readonly label = 'Start Work (Branch + Worktree)';

  canRun(item: WorkItem): boolean {
    return item.providerId === 'github' && item.state === 'New';
  }

  async run(item: WorkItem): Promise<void> {
    const issueNumber = this.extractIssueNumber(item.externalId);
    if (!issueNumber) {
      void vscode.window.showErrorMessage('Could not determine issue number.');
      return;
    }

    const branchName = this.generateBranchName(issueNumber, item.title);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showErrorMessage('WorkCenter: No workspace folder open. Open a repository first.');
      return;
    }

    let repoPath: string;
    try {
      repoPath = await this.selectRepository(workspaceFolders);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`WorkCenter: ${message}`);
      return;
    }

    try {
      // Check if branch already exists
      const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath });
      if (branchList.trim()) {
        void vscode.window.showErrorMessage(`WorkCenter: Branch "${branchName}" already exists.`);
        return;
      }

      // Create branch from remote tracking branch (prefer origin/dev, fallback to origin/main or default)
      let baseBranch = 'origin/dev';
      try {
        await execFileAsync('git', ['rev-parse', '--verify', 'origin/dev'], { cwd: repoPath });
      } catch {
        // origin/dev doesn't exist, try origin/main
        try {
          await execFileAsync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: repoPath });
          baseBranch = 'origin/main';
        } catch {
          // Fall back to current HEAD
          baseBranch = 'HEAD';
        }
      }
      await execFileAsync('git', ['branch', branchName, baseBranch], { cwd: repoPath });
      logger.info(`Starting work: creating branch ${branchName}`);

      // Create worktree
      const worktreePath = path.join(path.dirname(repoPath), branchName);
      
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
        throw worktreeErr;
      }

      logger.info(`Created worktree at ${worktreePath}`);

      // Open new VS Code window at worktree
      const worktreeUri = vscode.Uri.file(worktreePath);
      await vscode.commands.executeCommand('vscode.openFolder', worktreeUri, {
        forceNewWindow: true,
      });

      void vscode.window.showInformationMessage(
        `WorkCenter: Created worktree for ${branchName}`,
      );
    } catch (err: unknown) {
      logger.error('Failed to start work', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`WorkCenter: Failed to start work — ${message}`);
    }
  }

  private extractIssueNumber(externalId: string | undefined): string | undefined {
    if (!externalId) {
      return undefined;
    }
    // externalId format: "owner/repo#123"
    const match = externalId.match(/#(\d+)$/);
    return match ? match[1] : undefined;
  }

  private async selectRepository(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string> {
    // Find all folders with .git (directory or file for worktrees)
    const gitFolders = workspaceFolders.filter(folder => {
      const gitPath = path.join(folder.uri.fsPath, '.git');
      // existsSync returns true for both files and directories
      return fs.existsSync(gitPath);
    });

    if (gitFolders.length === 0) {
      throw new Error('No git repository found in workspace folders.');
    }

    if (gitFolders.length === 1) {
      return gitFolders[0].uri.fsPath;
    }

    // Multiple git repos: show quick pick
    const selected = await vscode.window.showQuickPick(
      gitFolders.map(folder => ({
        label: folder.name,
        detail: folder.uri.fsPath,
        folder,
      })),
      {
        placeHolder: 'Select repository to create work branch',
      }
    );

    if (!selected) {
      throw new Error('No repository selected.');
    }

    return selected.folder.uri.fsPath;
  }

  private generateBranchName(issueNumber: string, title: string): string {
    // "#123: Fix login redirect bug" → "issue-123-fix-login-redirect-bug"
    const slug = title
      .replace(/#\d+:\s*/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return slug ? `issue-${issueNumber}-${slug}` : `issue-${issueNumber}`;
  }
}

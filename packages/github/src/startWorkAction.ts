import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

interface WorkItem {
  id: string;
  title: string;
  description?: string;
  state: string;
  providerId?: string;
  externalId?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

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
    const issueNumber = this.extractIssueNumber(item.title);
    if (!issueNumber) {
      vscode.window.showErrorMessage('Could not determine issue number.');
      return;
    }

    const branchName = this.generateBranchName(issueNumber, item.title);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open. Open a repository first.');
      return;
    }

    const repoPath = workspaceFolders[0].uri.fsPath;

    try {
      // Check if branch already exists
      const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath });
      if (branchList.trim()) {
        vscode.window.showErrorMessage(`Branch "${branchName}" already exists.`);
        return;
      }

      // Create branch from current HEAD
      await execFileAsync('git', ['branch', branchName], { cwd: repoPath });

      // Create worktree
      const worktreePath = path.join(path.dirname(repoPath), branchName);
      
      // Check if worktree directory already exists
      if (fs.existsSync(worktreePath)) {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath });
        vscode.window.showErrorMessage(`Directory "${worktreePath}" already exists.`);
        return;
      }

      try {
        await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
          cwd: repoPath,
        });
      } catch (worktreeErr) {
        // Rollback: delete the branch we just created
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath });
        throw worktreeErr;
      }

      // Open new VS Code window at worktree
      const worktreeUri = vscode.Uri.file(worktreePath);
      await vscode.commands.executeCommand('vscode.openFolder', worktreeUri, {
        forceNewWindow: true,
      });

      vscode.window.showInformationMessage(
        `WorkCenter: Created worktree for ${branchName}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`WorkCenter: Failed to start work — ${message}`);
    }
  }

  private extractIssueNumber(title: string): string | undefined {
    const match = title.match(/#(\d+)/);
    return match ? match[1] : undefined;
  }

  private generateBranchName(issueNumber: string, title: string): string {
    // "#123: Fix login redirect bug" → "issue-123-fix-login-redirect-bug"
    const slug = title
      .replace(/#\d+:\s*/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `issue-${issueNumber}-${slug}`;
  }
}

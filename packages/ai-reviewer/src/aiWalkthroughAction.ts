import * as vscode from 'vscode';
import type { WorkItem, WorkCenterAction } from './types';
import { RepoManager } from './repoManager';

export class AiWalkthroughAction implements WorkCenterAction {
  readonly id = 'ai-reviewer.walkthrough';
  readonly label = 'PR Walkthrough';

  constructor(private readonly repoManager: RepoManager) {}

  canRun(item: WorkItem): boolean {
    if (!item.url) return false;
    return this.isPrUrl(item.url);
  }

  isPrUrl(url: string): boolean {
    return this.parseGitHubPrUrl(url) !== undefined;
  }

  parseGitHubPrUrl(url: string): { repo: string; prNumber: string } | undefined {
    const match = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:$|[\/?#])/);
    if (!match) return undefined;
    return { repo: match[1], prNumber: match[2] };
  }

  async run(item: WorkItem): Promise<void> {
    if (!item.url) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'PR Walkthrough',
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Preparing repository...' });

        try {
          await this.repoManager.ensureWorktree(item.url!);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`PR Walkthrough: Failed to prepare repository — ${msg}`);
          return;
        }

        if (token.isCancellationRequested) return;

        // Open chat with the walkthrough participant
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: `@walkthrough Walk me through this PR: ${item.url}`,
        });
      },
    );
  }
}

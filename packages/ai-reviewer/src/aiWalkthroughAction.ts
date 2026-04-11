import * as vscode from 'vscode';
import type { WorkItem, WorkCenterAction } from './types';
import { RepoManager } from './repoManager';
import { parsePrUrl } from './prUrl';

export class AiWalkthroughAction implements WorkCenterAction {
  readonly id = 'ai-reviewer.walkthrough';
  readonly label = 'AI Walkthrough';

  constructor(private readonly repoManager: RepoManager) {}

  canRun(item: WorkItem): boolean {
    if (!item.url) return false;
    return parsePrUrl(item.url) !== undefined;
  }

  async run(item: WorkItem): Promise<void> {
    if (!item.url) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AI Walkthrough',
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Preparing repository...' });

        try {
          await this.repoManager.ensureWorktree(item.url!);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`AI Walkthrough: Failed to prepare repository — ${msg}`);
          return;
        }

        if (token.isCancellationRequested) return;

        // Start a fresh chat conversation, then send the walkthrough query
        await vscode.commands.executeCommand('workbench.action.chat.newChat');
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: `@walkthrough Walk me through this PR: ${item.url}`,
        });
      },
    );
  }
}

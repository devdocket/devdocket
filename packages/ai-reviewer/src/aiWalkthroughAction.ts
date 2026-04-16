import * as vscode from 'vscode';
import type { WorkItem, DevDocketAction } from './types';
import { RepoManager } from './repoManager';
import { parsePrUrl } from './prUrl';

export class AiWalkthroughAction implements DevDocketAction {
  readonly id = 'ai-reviewer.walkthrough';
  readonly label = 'AI Walkthrough';

  constructor(
    private readonly repoManager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  canRun(item: WorkItem): boolean {
    const result = !!item.url && parsePrUrl(item.url) !== undefined;
    this.log.debug(`AiWalkthroughAction.canRun — url: ${item.url ?? '(none)'}, result: ${result}`);
    return result;
  }

  async run(item: WorkItem): Promise<void> {
    this.log.debug(`AiWalkthroughAction.run — url: ${item.url ?? '(none)'}`);
    if (!item.url) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AI Walkthrough',
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Preparing repository...' });
        this.log.info('Preparing worktree for walkthrough');

        try {
          await this.repoManager.ensureWorktree(item.url!);
          this.log.info('Worktree ready');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.error(`Worktree preparation failed: ${msg}`);
          vscode.window.showErrorMessage(`AI Walkthrough: Failed to prepare repository — ${msg}`);
          return;
        }

        if (token.isCancellationRequested) {
          this.log.info('Walkthrough cancelled before opening chat');
          return;
        }

        this.log.info('Opening chat with @walkthrough participant');
        // Start a fresh chat conversation, then send the walkthrough query
        await vscode.commands.executeCommand('workbench.action.chat.newChat');
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: `@walkthrough Walk me through this PR: ${item.url}`,
        });
        this.log.info('Chat opened');
      },
    );
  }
}

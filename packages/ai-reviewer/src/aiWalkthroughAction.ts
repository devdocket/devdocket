import * as vscode from 'vscode';
import type { WorkItem } from './types';
import { BasePrAction } from './basePrAction';
import { RepoManager } from './repoManager';

export class AiWalkthroughAction extends BasePrAction {
  readonly id = 'ai-reviewer.walkthrough';
  readonly label = 'AI Walkthrough';

  protected readonly progressTitle = 'AI Walkthrough';
  protected readonly confirmationMessage =
    'AI Walkthrough will use AI to analyze and walk through this PR. Continue?';

  constructor(
    private readonly repoManager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {
    super();
  }

  protected async doWork(
    item: WorkItem,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
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
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: `@walkthrough Walk me through this PR: ${item.url}`,
    });
    this.log.info('Chat opened');
  }
}

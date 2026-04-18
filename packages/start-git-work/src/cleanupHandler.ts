import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

/** Persisted metadata about a branch/worktree created by StartWorkAction. */
export interface GitWorkMetadata {
  branchName: string;
  worktreePath: string;
  repoPath: string;
}

/** Returns the globalState key used to store git work metadata for a work item. */
export function metadataKey(itemId: string): string {
  return `gitWork:${itemId}`;
}

// Re-declared to match core API contract
interface StateTransitionEvent {
  readonly item: Readonly<{ id: string; title: string }>;
  readonly oldState: string;
  readonly newState: string;
}

/**
 * Handles cleanup prompts when work items transition to Done.
 *
 * Checks if a branch/worktree was created for the item via StartWorkAction
 * and prompts the user to delete them.
 */
export class CleanupHandler {
  private readonly globalState: vscode.Memento;

  constructor(globalState: vscode.Memento) {
    this.globalState = globalState;
  }

  /**
   * Called when a work item transitions state. If transitioning to Done and
   * git work metadata exists, prompts the user to clean up the branch/worktree.
   */
  async handleStateTransition(event: StateTransitionEvent): Promise<void> {
    if (event.newState !== 'Done') {
      return;
    }

    const key = metadataKey(event.item.id);
    const metadata = this.globalState.get<GitWorkMetadata>(key);
    if (!metadata) {
      return;
    }

    const worktreeExists = fs.existsSync(metadata.worktreePath);
    const branchExists = await this.branchExists(metadata.branchName, metadata.repoPath);

    if (!worktreeExists && !branchExists) {
      // Already cleaned up — remove stale metadata
      await this.globalState.update(key, undefined);
      return;
    }

    const resources: string[] = [];
    if (worktreeExists) { resources.push(`worktree "${metadata.worktreePath}"`); }
    if (branchExists) { resources.push(`branch "${metadata.branchName}"`); }

    const isPlural = resources.length > 1;
    const verb = isPlural ? 'exist' : 'exists';
    const pronoun = isPlural ? 'them' : 'it';

    const answer = await vscode.window.showInformationMessage(
      `The ${resources.join(' and ')} for "${event.item.title}" still ${verb}. Delete ${pronoun}?`,
      'Yes',
      'No',
    );

    if (answer !== 'Yes') {
      // User declined or dismissed — clear metadata so we don't ask again
      await this.globalState.update(key, undefined);
      return;
    }

    await this.performCleanup(metadata, key);
  }

  private async performCleanup(metadata: GitWorkMetadata, stateKey: string): Promise<void> {
    let worktreeRemoved = false;
    let branchDeleted = false;

    // Remove worktree first (it must be removed before the branch can be deleted)
    if (fs.existsSync(metadata.worktreePath)) {
      try {
        await execFileAsync('git', ['worktree', 'remove', metadata.worktreePath], {
          cwd: metadata.repoPath,
        });
        worktreeRemoved = true;
        logger.info(`Removed worktree at ${metadata.worktreePath}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to remove worktree at ${metadata.worktreePath}`, err);
        void vscode.window.showWarningMessage(
          `DevDocket: Failed to remove worktree — ${message}`,
        );
      }
    } else {
      worktreeRemoved = true;
    }

    // Delete the branch (use -d to warn about unmerged changes)
    if (await this.branchExists(metadata.branchName, metadata.repoPath)) {
      try {
        await execFileAsync('git', ['branch', '-d', metadata.branchName], {
          cwd: metadata.repoPath,
        });
        branchDeleted = true;
        logger.info(`Deleted branch ${metadata.branchName}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stderr = (err as any)?.stderr ?? '';
        // git branch -d fails when the branch has unmerged changes
        if (message.includes('not fully merged') || stderr.includes('not fully merged')) {
          void vscode.window.showWarningMessage(
            `DevDocket: Branch "${metadata.branchName}" has unmerged changes and was not deleted. Use \`git branch -D ${metadata.branchName}\` to force-delete.`,
          );
        } else {
          logger.error(`Failed to delete branch ${metadata.branchName}`, err);
          void vscode.window.showWarningMessage(
            `DevDocket: Failed to delete branch — ${message}`,
          );
        }
      }
    } else {
      branchDeleted = true;
    }

    // Clear metadata if both resources were cleaned up
    if (worktreeRemoved && branchDeleted) {
      await this.globalState.update(stateKey, undefined);
    }
  }

  private async branchExists(branchName: string, repoPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--list', branchName], {
        cwd: repoPath,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}

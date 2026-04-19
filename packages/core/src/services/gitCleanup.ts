import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WorkItem } from '../models/workItem';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface CleanupState {
  worktreeExists: boolean;
  branchExists: boolean;
  repoPath?: string;
}

/**
 * Checks if a git worktree and branch still exist for a completed work item.
 */
async function checkCleanupState(item: WorkItem): Promise<CleanupState | undefined> {
  if (!item.branchName && !item.worktreePath) {
    return undefined;
  }

  if (!item.repoPath) {
    logger.warn('Cannot check cleanup state: repoPath is missing');
    return undefined;
  }

  const repoPath = item.repoPath;
  const worktreeExists = item.worktreePath ? await pathExists(item.worktreePath) : false;
  let branchExists = false;

  // Check branch existence if we have a branchName
  if (item.branchName) {
    if (await pathExists(path.join(repoPath, '.git'))) {
      try {
        await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${item.branchName}`], { cwd: repoPath });
        branchExists = true;
      } catch (err) {
        // Exit code 1 means ref not found; anything else is an unexpected error
        if ((err as { code?: number | string }).code === 1) {
          branchExists = false;
        } else {
          logger.warn(`Failed to check branch existence for ${item.branchName}`, err);
        }
      }
    }
  }

  if (!worktreeExists && !branchExists) {
    return undefined;
  }

  return { worktreeExists, branchExists, repoPath };
}

/**
 * Prompts the user to clean up a git worktree and branch, and performs the cleanup if confirmed.
 * If dismissed, calls onDismiss so the caller can persist the dismissal flag.
 */
export async function promptGitCleanup(
  item: WorkItem,
  onDismiss?: () => Promise<void>,
): Promise<void> {
  if (item.cleanupDismissed) {
    return;
  }

  const state = await checkCleanupState(item);
  if (!state) {
    return;
  }

  const { worktreeExists, branchExists, repoPath } = state;

  const parts: string[] = [];
  if (worktreeExists && item.worktreePath) {
    parts.push(`worktree at "${item.worktreePath}"`);
  }
  if (branchExists && item.branchName) {
    parts.push(`branch "${item.branchName}"`);
  }

  const message = `The ${parts.join(' and ')} for this item still exists. Delete them?`;
  const choice = await vscode.window.showInformationMessage(message, 'Yes', 'No');

  if (choice !== 'Yes') {
    if (onDismiss) {
      await onDismiss();
    }
    return;
  }

  // Perform cleanup
  const errors: string[] = [];

  if (worktreeExists && item.worktreePath && repoPath) {
    try {
      await execFileAsync('git', ['worktree', 'remove', item.worktreePath], { cwd: repoPath });
      logger.info(`Removed worktree: ${item.worktreePath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to remove worktree: ${message}`);
      logger.error('Failed to remove worktree', err);
    }
  }

  if (branchExists && item.branchName && repoPath) {
    try {
      await execFileAsync('git', ['branch', '-d', item.branchName], { cwd: repoPath });
      logger.info(`Deleted branch: ${item.branchName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = (err as any)?.stderr ?? '';
      if (stderr.includes('not fully merged')) {
        errors.push(`Branch "${item.branchName}" has unmerged changes — use 'git branch -D' to force delete`);
      } else {
        errors.push(`Failed to delete branch: ${message}`);
      }
      logger.error('Failed to delete branch', err);
    }
  }

  if (errors.length > 0) {
    void vscode.window.showErrorMessage(`DevDocket: ${errors.join('; ')}`);
  } else {
    void vscode.window.showInformationMessage('DevDocket: Cleanup completed successfully');
  }
}

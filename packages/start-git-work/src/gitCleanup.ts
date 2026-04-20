import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
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

// Re-declared locally — start-git-work cannot import core types directly.
interface ActivityLogEntry {
  timestamp: number;
  type: string;
  detail?: string;
}

interface WorkItem {
  id: string;
  activityLog?: ActivityLogEntry[];
}

/** Structured data stored in the detail field of a 'work-started' activity entry. */
interface WorkStartedData {
  branchName?: string;
  worktreePath?: string;
  repoPath?: string;
}

/**
 * Extract branch/worktree/repo info from the item's activity log.
 * Finds the most recent 'work-started' entry, then checks whether a
 * 'cleanup-dismissed' entry exists after it (which suppresses prompting).
 */
function getWorkStartedInfo(item: WorkItem): WorkStartedData | undefined {
  const log = item.activityLog;
  if (!log || log.length === 0) {
    return undefined;
  }

  let lastStartedIdx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === 'work-started') {
      lastStartedIdx = i;
      break;
    }
  }

  if (lastStartedIdx === -1) {
    return undefined;
  }

  // Check if cleanup was dismissed after this work-started entry
  for (let i = lastStartedIdx + 1; i < log.length; i++) {
    if (log[i].type === 'cleanup-dismissed') {
      return undefined;
    }
  }

  const detail = log[lastStartedIdx].detail;
  if (!detail) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    return {
      branchName: typeof parsed.branchName === 'string' ? parsed.branchName : undefined,
      worktreePath: typeof parsed.worktreePath === 'string' ? parsed.worktreePath : undefined,
      repoPath: typeof parsed.repoPath === 'string' ? parsed.repoPath : undefined,
    };
  } catch {
    logger.warn('Failed to parse work-started activity detail');
    return undefined;
  }
}

interface CleanupState {
  worktreeExists: boolean;
  branchExists: boolean;
  repoPath: string;
  branchName?: string;
  worktreePath?: string;
}

async function checkCleanupState(item: WorkItem): Promise<CleanupState | undefined> {
  const info = getWorkStartedInfo(item);
  if (!info) {
    return undefined;
  }

  if (!info.branchName && !info.worktreePath) {
    return undefined;
  }

  if (!info.repoPath) {
    logger.warn('Cannot check cleanup state: repoPath is missing');
    return undefined;
  }

  const repoPath = info.repoPath;
  if (!await pathExists(path.join(repoPath, '.git'))) {
    logger.warn('Skipping cleanup: repoPath is not a valid git repo');
    return undefined;
  }

  const worktreeExists = info.worktreePath ? await pathExists(info.worktreePath) : false;
  let branchExists = false;

  if (info.branchName) {
    try {
      await execFileAsync('git', ['show-ref', '--verify', '--quiet', '--', `refs/heads/${info.branchName}`], { cwd: repoPath });
      branchExists = true;
    } catch (err) {
      if ((err as { code?: number | string }).code === 1) {
        branchExists = false;
      } else {
        logger.warn(`Failed to check branch existence for ${info.branchName}`, err);
      }
    }
  }

  if (!worktreeExists && !branchExists) {
    return undefined;
  }

  return { worktreeExists, branchExists, repoPath, branchName: info.branchName, worktreePath: info.worktreePath };
}

/**
 * Prompts the user to clean up a git worktree and branch for a completed work item.
 * Reads branch/worktree info from the item's activity log (most recent 'work-started' entry).
 *
 * @param item - The work item (must include activityLog).
 * @param addActivity - Callback to log activity entries on the item.
 */
export async function promptGitCleanup(
  item: WorkItem,
  addActivity: (itemId: string, type: string, detail?: string) => Promise<void>,
): Promise<void> {
  const state = await checkCleanupState(item);
  if (!state) {
    return;
  }

  const { worktreeExists, branchExists, repoPath, branchName, worktreePath } = state;

  const parts: string[] = [];
  if (worktreeExists && worktreePath) {
    parts.push(`worktree at "${worktreePath}"`);
  }
  if (branchExists && branchName) {
    parts.push(`branch "${branchName}"`);
  }

  const hasSingleTarget = parts.length === 1;
  const message = `The ${parts.join(' and ')} for this item still ${hasSingleTarget ? 'exists' : 'exist'}. Delete ${hasSingleTarget ? 'it' : 'them'}?`;
  const choice = await vscode.window.showInformationMessage(message, 'Yes', 'No');

  if (choice === 'No') {
    try {
      await addActivity(item.id, 'cleanup-dismissed');
    } catch (err) {
      logger.warn('Failed to log cleanup-dismissed activity', err);
    }
    return;
  }

  if (choice !== 'Yes') {
    return;
  }

  // Perform cleanup
  const errors: string[] = [];
  const cleaned: string[] = [];
  let worktreeRemoved = true;

  if (worktreeExists && worktreePath && repoPath) {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--', worktreePath], { cwd: repoPath });
      logger.info('Removed worktree for work item');
      cleaned.push(`worktree`);
    } catch (err) {
      worktreeRemoved = false;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to remove worktree: ${message}`);
      logger.error('Failed to remove worktree', err);
    }
  }

  // Skip branch deletion if worktree removal failed — branch is likely still checked out
  if (branchExists && branchName && repoPath && worktreeRemoved) {
    try {
      await execFileAsync('git', ['branch', '-d', '--', branchName], { cwd: repoPath });
      logger.info(`Deleted branch: ${branchName}`);
      cleaned.push(`branch ${branchName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = (err as any)?.stderr ?? '';
      if (stderr.includes('not fully merged')) {
        errors.push(`Branch "${branchName}" has unmerged changes — use 'git branch -D' to force delete`);
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

  if (cleaned.length > 0) {
    try {
      await addActivity(item.id, 'cleanup', `Removed ${cleaned.join(' and ')}`);
    } catch (err) {
      logger.warn('Failed to log cleanup activity', err);
    }
  }
}

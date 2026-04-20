import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemState, type WorkItem } from '../models/workItem';
import type { ActivityLogEntry } from '../models/activityLog';

vi.mock('fs/promises', () => ({
  access: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: vi.fn((fn: any) => fn),
  };
});

vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promptGitCleanup } from '../services/gitCleanup';

/** Helper to build a work-started activity entry with JSON detail. */
function workStartedEntry(data: { branchName?: string; worktreePath?: string; repoPath?: string }): ActivityLogEntry {
  return { timestamp: Date.now(), type: 'work-started', detail: JSON.stringify(data) };
}

function createItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wc-test-1',
    title: 'Test Item',
    state: WorkItemState.Done,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('promptGitCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when item has no activity log', async () => {
    await promptGitCleanup(createItem());

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when activity log has no work-started entry', async () => {
    await promptGitCleanup(createItem({
      activityLog: [{ timestamp: Date.now(), type: 'created' }],
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when cleanup-dismissed follows work-started', async () => {
    await promptGitCleanup(createItem({
      activityLog: [
        workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' }),
        { timestamp: Date.now(), type: 'cleanup-dismissed' },
      ],
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when repoPath is missing from work-started detail', async () => {
    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x' })],
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('prompts when branch exists and user confirms cleanup', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('branch "feature/x"'),
      'Yes', 'No',
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'DevDocket: Cleanup completed successfully',
    );
  });

  it('calls onCleanup with detail when branch is deleted', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    const onCleanup = vi.fn().mockResolvedValue(undefined);

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }), undefined, onCleanup);

    expect(onCleanup).toHaveBeenCalledWith('Removed branch feature/x');
  });

  it('calls onCleanup with detail for both worktree and branch', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    const onCleanup = vi.fn().mockResolvedValue(undefined);

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', worktreePath: '/wt/path', repoPath: '/repos/main' })],
    }), undefined, onCleanup);

    expect(onCleanup).toHaveBeenCalledWith('Removed worktree and branch feature/x');
  });

  it('does not run cleanup when user clicks No', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('No');

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }));

    expect(execFile as unknown as Mock).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss callback when user clicks No', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('No');
    const onDismiss = vi.fn().mockResolvedValue(undefined);

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }), onDismiss);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows error for unmerged branch', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error('branch delete failed'), { stderr: 'error: The branch is not fully merged' }),
    );

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('unmerged changes'),
    );
  });

  it('does not prompt when neither branch nor worktree exist', async () => {
    (fs.access as Mock).mockImplementation(async (p: string) => {
      if (p.endsWith('.git')) {
        return undefined;
      }
      throw new Error('ENOENT');
    });
    (execFile as unknown as Mock).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 1 }));

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/gone', worktreePath: '/nonexistent/path', repoPath: '/repos/main' })],
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('uses the most recent work-started entry', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });

    await promptGitCleanup(createItem({
      activityLog: [
        workStartedEntry({ branchName: 'old-branch', repoPath: '/repos/main' }),
        workStartedEntry({ branchName: 'new-branch', repoPath: '/repos/main' }),
      ],
    }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('branch "new-branch"'),
      'Yes', 'No',
    );
  });
});

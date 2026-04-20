import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemState, type WorkItem } from '../models/workItem';

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

  it('does nothing when item has no branch or worktree metadata', async () => {
    await promptGitCleanup(createItem());

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when item has cleanupDismissed set', async () => {
    await promptGitCleanup(createItem({
      branchName: 'feature/x',
      repoPath: '/repos/main',
      cleanupDismissed: true,
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when repoPath is missing', async () => {
    await promptGitCleanup(createItem({
      branchName: 'feature/x',
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('prompts when branch exists and user confirms cleanup', async () => {
    // fs.access succeeds for .git check
    (fs.access as Mock).mockResolvedValue(undefined);
    // git show-ref succeeds (branch exists)
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    // User clicks "Yes"
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    // git branch -d succeeds
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });

    await promptGitCleanup(createItem({
      branchName: 'feature/x',
      repoPath: '/repos/main',
    }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('branch "feature/x"'),
      'Yes', 'No',
    );
    // Success message
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
      branchName: 'feature/x',
      repoPath: '/repos/main',
    }), undefined, onCleanup);

    expect(onCleanup).toHaveBeenCalledWith('Removed branch feature/x');
  });

  it('calls onCleanup with detail for both worktree and branch', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    // show-ref succeeds (branch exists)
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    // worktree remove succeeds
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    // branch -d succeeds
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    const onCleanup = vi.fn().mockResolvedValue(undefined);

    await promptGitCleanup(createItem({
      branchName: 'feature/x',
      worktreePath: '/wt/path',
      repoPath: '/repos/main',
    }), undefined, onCleanup);

    expect(onCleanup).toHaveBeenCalledWith('Removed worktree and branch feature/x');
  });

  it('does not run cleanup when user clicks No', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('No');

    await promptGitCleanup(createItem({
      branchName: 'feature/x',
      repoPath: '/repos/main',
    }));

    // Only the prompt call, no success/error messages
    expect(execFile as unknown as Mock).toHaveBeenCalledTimes(1); // only show-ref, not branch -d
  });

  it('calls onDismiss callback when user clicks No', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('No');
    const onDismiss = vi.fn().mockResolvedValue(undefined);

    await promptGitCleanup(createItem({
      branchName: 'feature/x',
      repoPath: '/repos/main',
    }), onDismiss);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows error for unmerged branch', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    // git show-ref succeeds
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    // git branch -d fails with unmerged
    (execFile as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error('branch delete failed'), { stderr: 'error: The branch is not fully merged' }),
    );

    await promptGitCleanup(createItem({
      branchName: 'feature/x',
      repoPath: '/repos/main',
    }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('unmerged changes'),
    );
  });

  it('does not prompt when neither branch nor worktree exist', async () => {
    // .git check succeeds, but worktree path doesn't exist
    (fs.access as Mock).mockImplementation(async (p: string) => {
      if (p.endsWith('.git')) {
        return undefined;
      }
      throw new Error('ENOENT');
    });
    // git show-ref exits with 1 (branch not found)
    (execFile as unknown as Mock).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 1 }));

    await promptGitCleanup(createItem({
      branchName: 'feature/gone',
      worktreePath: '/nonexistent/path',
      repoPath: '/repos/main',
    }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});

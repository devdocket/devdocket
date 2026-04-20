import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';

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

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promptGitCleanup } from '../gitCleanup';

function workStartedEntry(data: { branchName?: string; worktreePath?: string; repoPath?: string }) {
  return { timestamp: Date.now(), type: 'work-started', detail: JSON.stringify(data) };
}

function createItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wc-test-1',
    ...overrides,
  };
}

describe('promptGitCleanup', () => {
  let addActivity: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    addActivity = vi.fn().mockResolvedValue(undefined);
  });

  it('does nothing when item has no activity log', async () => {
    await promptGitCleanup(createItem(), addActivity);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when cleanup-dismissed follows work-started', async () => {
    await promptGitCleanup(createItem({
      activityLog: [
        workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' }),
        { timestamp: Date.now(), type: 'cleanup-dismissed' },
      ],
    }), addActivity);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('prompts when branch exists and user confirms', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }), addActivity);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('branch "feature/x"'), 'Yes', 'No',
    );
    expect(addActivity).toHaveBeenCalledWith('wc-test-1', 'cleanup', 'Removed branch feature/x');
  });

  it('logs cleanup-dismissed when user clicks No', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('No');

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }), addActivity);

    expect(addActivity).toHaveBeenCalledWith('wc-test-1', 'cleanup-dismissed');
  });

  it('shows error for unmerged branch', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('Yes');
    (execFile as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error('fail'), { stderr: 'error: The branch is not fully merged' }),
    );

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }), addActivity);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('unmerged changes'),
    );
  });

  it('does not prompt when neither branch nor worktree exist', async () => {
    (fs.access as Mock).mockImplementation(async (p: string) => {
      if (p.endsWith('.git')) { return undefined; }
      throw new Error('ENOENT');
    });
    (execFile as unknown as Mock).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 1 }));

    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/gone', worktreePath: '/nope', repoPath: '/repos/main' })],
    }), addActivity);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('handles addActivity failure gracefully', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);
    (execFile as unknown as Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValue('No');
    addActivity.mockRejectedValue(new Error('API error'));

    // Should not throw
    await promptGitCleanup(createItem({
      activityLog: [workStartedEntry({ branchName: 'feature/x', repoPath: '/repos/main' })],
    }), addActivity);
  });
});

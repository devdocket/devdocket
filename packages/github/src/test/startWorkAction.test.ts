import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace, commands, Uri } from 'vscode';
import { StartWorkAction } from '../startWorkAction';
import * as path from 'path';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb: Function) => {
    cb(null, '', '');
  }),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

import { execFile } from 'child_process';
import * as fs from 'fs';

function createWorkItem(overrides: Partial<any> = {}) {
  return {
    id: 'wc-test-1',
    title: '#123: Fix login redirect bug',
    description: 'Some description',
    state: 'New',
    providerId: 'github',
    externalId: 'owner/repo#123',
    url: 'https://github.com/owner/repo/issues/123',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('StartWorkAction', () => {
  let action: StartWorkAction;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new StartWorkAction();

    // Default workspace mock
    (workspace as any).workspaceFolders = [
      { uri: { fsPath: '/mock/workspace' } },
    ];

    // Reset execFile mock to succeed with empty output
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      cb(null, { stdout: '', stderr: '' }, '');
    }) as any);

    // Reset fs.existsSync to return false for worktree directories, true for .git
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('.git');
    });
  });

  describe('canRun', () => {
    it('returns true for github provider items in New state', () => {
      const item = createWorkItem({ providerId: 'github', state: 'New' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns false for non-github provider items', () => {
      const item = createWorkItem({ providerId: 'jira', state: 'New' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for items without a provider', () => {
      const item = createWorkItem({ providerId: undefined, state: 'New' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for non-New state items', () => {
      const inProgress = createWorkItem({ state: 'InProgress' });
      expect(action.canRun(inProgress)).toBe(false);

      const done = createWorkItem({ state: 'Done' });
      expect(action.canRun(done)).toBe(false);

      const blocked = createWorkItem({ state: 'Blocked' });
      expect(action.canRun(blocked)).toBe(false);
    });
  });

  describe('run', () => {
    it('creates branch and worktree with correct names', async () => {
      const item = createWorkItem({ title: '#123: Fix login redirect bug' });
      await action.run(item);

      expect(execFile).toHaveBeenCalledTimes(4);

      // First call: check if branch exists
      const firstCall = vi.mocked(execFile).mock.calls[0];
      expect(firstCall[0]).toBe('git');
      expect(firstCall[1]).toEqual(['branch', '--list', 'issue-123-fix-login-redirect-bug']);
      expect(firstCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Second call: verify origin/dev exists
      const secondCall = vi.mocked(execFile).mock.calls[1];
      expect(secondCall[0]).toBe('git');
      expect(secondCall[1]).toEqual(['rev-parse', '--verify', 'origin/dev']);
      expect(secondCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Third call: create branch
      const thirdCall = vi.mocked(execFile).mock.calls[2];
      expect(thirdCall[0]).toBe('git');
      expect(thirdCall[1]).toEqual(['branch', 'issue-123-fix-login-redirect-bug', 'origin/dev']);
      expect(thirdCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Fourth call: create worktree
      const fourthCall = vi.mocked(execFile).mock.calls[3];
      expect(fourthCall[0]).toBe('git');
      expect(fourthCall[1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'issue-123-fix-login-redirect-bug'),
        'issue-123-fix-login-redirect-bug',
      ]);
    });

    it('generates slug from title correctly', async () => {
      const item = createWorkItem({ title: '#456: Add User Authentication!!', externalId: 'owner/repo#456' });
      await action.run(item);

      // Third call is the branch creation (first is branch check, second is origin/dev verify)
      const branchCall = vi.mocked(execFile).mock.calls[2];
      expect(branchCall[1]).toEqual(['branch', 'issue-456-add-user-authentication', 'origin/dev']);
    });

    it('truncates slug to 40 chars', async () => {
      const item = createWorkItem({
        title: '#789: This is a very long title that should be truncated to forty characters maximum',
        externalId: 'owner/repo#789',
      });
      await action.run(item);

      const branchCall = vi.mocked(execFile).mock.calls[0];
      const branchName = branchCall[1]![1] as string;
      // "issue-789-" is 10 chars, slug part should be at most 40 chars
      const slug = branchName.replace('issue-789-', '');
      expect(slug.length).toBeLessThanOrEqual(40);
    });

    it('opens new VS Code window at worktree path', async () => {
      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      // C7 fix: now uses path.join(path.dirname(...), branchName)
      expect(Uri.file).toHaveBeenCalledWith(path.join('/mock', 'issue-123-fix-bug'));
      expect(commands.executeCommand).toHaveBeenCalledWith(
        'vscode.openFolder',
        expect.anything(),
        { forceNewWindow: true },
      );
    });

    it('shows success message after creating worktree', async () => {
      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Created worktree for issue-123-fix-bug',
      );
    });

    it('shows error when issue number cannot be extracted', async () => {
      const item = createWorkItem({ title: 'No issue number here', externalId: 'invalid-format' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine issue number.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when no workspace folders exist', async () => {
      (workspace as any).workspaceFolders = undefined;
      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: No workspace folder open. Open a repository first.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when workspace folders is empty array', async () => {
      (workspace as any).workspaceFolders = [];
      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: No workspace folder open. Open a repository first.',
      );
    });

    it('shows error when git command fails', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(new Error('git branch failed: already exists'), '', '');
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('git branch failed'),
      );
    });

    it('shows error when branch already exists', async () => {
      // Mock branch --list to return existing branch
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: 'issue-123-fix-bug\n', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Branch "issue-123-fix-bug" already exists.',
      );
      // Should not attempt to create branch or worktree
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    it('shows error and deletes branch when worktree directory already exists', async () => {
      // Mock fs.existsSync to return true (directory exists)
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        `WorkCenter: Directory "${path.join('/mock', 'issue-123-fix-bug')}" already exists.`,
      );
      // Should delete the branch (I6 rollback fix)
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['branch', '-D', 'issue-123-fix-bug'],
        { cwd: '/mock/workspace' },
        expect.any(Function),
      );
    });

    it('deletes branch if worktree creation fails', async () => {
      // Mock worktree add to fail
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'worktree') {
          cb(new Error('worktree add failed'), '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('worktree add failed'),
      );
      // Should rollback by deleting the branch (I6 fix)
      const deleteCalls = vi.mocked(execFile).mock.calls.filter(
        call => call[1]![0] === 'branch' && call[1]![1] === '-D'
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });

  describe('error scenarios', () => {
    it('falls back to origin/main when origin/dev does not exist', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'rev-parse' && args[2] === 'origin/dev') {
          cb(new Error('not found'), '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      // Branch creation should use origin/main as base
      const branchCreateCall = vi.mocked(execFile).mock.calls.find(
        call => call[1]![0] === 'branch' && call[1]![1] !== '--list'
      );
      expect(branchCreateCall).toBeDefined();
      expect(branchCreateCall![1]).toEqual(['branch', 'issue-123-fix-bug', 'origin/main']);
    });

    it('falls back to HEAD when neither origin/dev nor origin/main exist', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'rev-parse' && args[2] === 'origin/dev') {
          cb(new Error('not found'), '', '');
        } else if (args[0] === 'rev-parse' && args[2] === 'origin/main') {
          cb(new Error('not found'), '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      const branchCreateCall = vi.mocked(execFile).mock.calls.find(
        call => call[1]![0] === 'branch' && call[1]![1] !== '--list'
      );
      expect(branchCreateCall).toBeDefined();
      expect(branchCreateCall![1]).toEqual(['branch', 'issue-123-fix-bug', 'HEAD']);
    });

    it('shows quick pick when multiple workspace folders have .git', async () => {
      (workspace as any).workspaceFolders = [
        { name: 'repo1', uri: { fsPath: '/mock/repo1' } },
        { name: 'repo2', uri: { fsPath: '/mock/repo2' } },
      ];

      // Both folders have .git
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString().endsWith('.git');
      });

      // User selects second repo
      vi.mocked(window.showQuickPick).mockResolvedValue({
        label: 'repo2',
        detail: '/mock/repo2',
        folder: { name: 'repo2', uri: { fsPath: '/mock/repo2' } },
      } as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: 'repo1' }),
          expect.objectContaining({ label: 'repo2' }),
        ]),
        expect.objectContaining({ placeHolder: 'Select repository to create work branch' }),
      );

      // Branch should be created in the selected repo
      const branchCreateCall = vi.mocked(execFile).mock.calls.find(
        call => call[1]![0] === 'branch' && call[1]![1] !== '--list'
      );
      expect(branchCreateCall).toBeDefined();
      expect(branchCreateCall![2]).toEqual({ cwd: '/mock/repo2' });
    });

    it('shows error when user cancels quick pick', async () => {
      (workspace as any).workspaceFolders = [
        { name: 'repo1', uri: { fsPath: '/mock/repo1' } },
        { name: 'repo2', uri: { fsPath: '/mock/repo2' } },
      ];

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString().endsWith('.git');
      });

      // User cancels quick pick
      vi.mocked(window.showQuickPick).mockResolvedValue(undefined);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: No repository selected.',
      );
      // Should not attempt any git operations
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when no workspace folders contain a git repository', async () => {
      (workspace as any).workspaceFolders = [
        { name: 'folder1', uri: { fsPath: '/mock/folder1' } },
        { name: 'folder2', uri: { fsPath: '/mock/folder2' } },
      ];

      // No folders have .git
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: No git repository found in workspace folders.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rolls back branch with git branch -D when worktree creation fails', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          cb(new Error('fatal: worktree add failed'), '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      const calls = vi.mocked(execFile).mock.calls;

      // Find the worktree add call index
      const worktreeIdx = calls.findIndex(c => c[1]![0] === 'worktree');
      // Find the rollback branch -D call index
      const rollbackIdx = calls.findIndex(c => c[1]![0] === 'branch' && c[1]![1] === '-D');

      expect(worktreeIdx).toBeGreaterThan(-1);
      expect(rollbackIdx).toBeGreaterThan(-1);
      // Rollback must happen after worktree add
      expect(rollbackIdx).toBeGreaterThan(worktreeIdx);

      // Verify rollback call args
      expect(calls[rollbackIdx][1]).toEqual(['branch', '-D', 'issue-123-fix-bug']);
      expect(calls[rollbackIdx][2]).toEqual({ cwd: '/mock/workspace' });

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('fatal: worktree add failed'),
      );
    });

    it('shows warning when rollback itself fails after worktree creation failure', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          cb(new Error('worktree add failed'), '', '');
        } else if (args[0] === 'branch' && args[1] === '-D') {
          cb(new Error('branch delete failed: ref not found'), '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      // Warning about failed rollback
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete branch during rollback'),
      );
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('branch delete failed: ref not found'),
      );

      // Original error is still shown
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('worktree add failed'),
      );
    });

    it('shows error when externalId is undefined', async () => {
      const item = createWorkItem({ externalId: undefined });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine issue number.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when externalId has no issue number pattern', async () => {
      const item = createWorkItem({ externalId: 'owner/repo' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine issue number.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace, commands, Uri } from 'vscode';
import { StartWorkAction } from '../startWorkAction';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb: Function) => {
    cb(null, '', '');
  }),
}));

import { execFile } from 'child_process';

function createWorkItem(overrides: Partial<any> = {}) {
  return {
    id: 'wc-test-1',
    title: '#123: Fix login redirect bug',
    description: 'Some description',
    state: 'New',
    providerId: 'github',
    externalId: 'github-issue-123',
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

    // Reset execFile mock
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      cb(null, '', '');
    }) as any);
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

      expect(execFile).toHaveBeenCalledTimes(2);

      // First call: create branch
      const firstCall = vi.mocked(execFile).mock.calls[0];
      expect(firstCall[0]).toBe('git');
      expect(firstCall[1]).toEqual(['branch', 'issue-123-fix-login-redirect-bug']);
      expect(firstCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Second call: create worktree
      const secondCall = vi.mocked(execFile).mock.calls[1];
      expect(secondCall[0]).toBe('git');
      expect(secondCall[1]).toEqual([
        'worktree', 'add',
        '/mock/workspace/../issue-123-fix-login-redirect-bug',
        'issue-123-fix-login-redirect-bug',
      ]);
    });

    it('generates slug from title correctly', async () => {
      const item = createWorkItem({ title: '#456: Add User Authentication!!' });
      await action.run(item);

      const branchCall = vi.mocked(execFile).mock.calls[0];
      expect(branchCall[1]).toEqual(['branch', 'issue-456-add-user-authentication']);
    });

    it('truncates slug to 40 chars', async () => {
      const item = createWorkItem({
        title: '#789: This is a very long title that should be truncated to forty characters maximum',
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

      expect(Uri.file).toHaveBeenCalledWith('/mock/workspace/../issue-123-fix-bug');
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
        expect.stringContaining('issue-123-fix-bug'),
      );
    });

    it('shows error when issue number cannot be extracted', async () => {
      const item = createWorkItem({ title: 'No issue number here' });
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
        'No workspace folder open. Open a repository first.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when workspace folders is empty array', async () => {
      (workspace as any).workspaceFolders = [];
      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'No workspace folder open. Open a repository first.',
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
  });
});

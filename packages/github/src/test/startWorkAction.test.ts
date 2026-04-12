import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, commands, Uri } from 'vscode';
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
    state: 'InProgress',
    providerId: 'github',
    externalId: 'owner/repo#123',
    url: 'https://github.com/owner/repo/issues/123',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockMemento() {
  const store = new Map<string, any>();
  return {
    get: vi.fn((key: string, defaultValue?: any) => store.has(key) ? store.get(key) : defaultValue),
    update: vi.fn(async (key: string, value: any) => { store.set(key, value); }),
    keys: () => [...store.keys()],
    _store: store,
  };
}

/** Sets up showInputBox to return specific values based on which prompt is shown. */
function mockInputBox(repoPath: string | undefined, baseBranch: string | undefined) {
  vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
    if (options?.prompt?.includes('local path')) {
      return repoPath;
    }
    if (options?.prompt?.includes('base branch')) {
      return baseBranch;
    }
    return undefined;
  });
}

describe('StartWorkAction', () => {
  let action: StartWorkAction;
  let mockMemento: ReturnType<typeof createMockMemento>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMemento = createMockMemento();
    action = new StartWorkAction(mockMemento as any);

    // Default: showInputBox returns repo path and base branch based on prompt
    mockInputBox('/mock/workspace', 'origin/dev');

    // Reset execFile mock to succeed with empty output
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      cb(null, { stdout: '', stderr: '' }, '');
    }) as any);

    // Return true for .git paths (repo validation), false otherwise (worktree check)
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('.git');
    });
  });

  describe('canRun', () => {
    it('returns true for github provider items in InProgress state', () => {
      const item = createWorkItem({ providerId: 'github', state: 'InProgress' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns false for non-github provider items', () => {
      const item = createWorkItem({ providerId: 'jira', state: 'InProgress' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for items without a provider', () => {
      const item = createWorkItem({ providerId: undefined, state: 'InProgress' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for non-InProgress state items', () => {
      const newItem = createWorkItem({ state: 'New' });
      expect(action.canRun(newItem)).toBe(false);

      const done = createWorkItem({ state: 'Done' });
      expect(action.canRun(done)).toBe(false);

      const paused = createWorkItem({ state: 'Paused' });
      expect(action.canRun(paused)).toBe(false);
    });
  });

  describe('repo path prompting', () => {
    it('prompts user for repo path with no default on first use', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Enter the local path to the git repository for owner/repo',
        value: '',
        ignoreFocusOut: true,
      });
    });

    it('pre-fills cached path as default on subsequent use', async () => {
      mockMemento._store.set('repoPath:owner/repo', '/cached/path');
      mockInputBox('/cached/path', 'origin/dev');

      const item = createWorkItem();
      await action.run(item);

      expect(window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: '/cached/path' }),
      );
    });

    it('caches the selected repo path on success', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).toHaveBeenCalledWith('repoPath:owner/repo', '/mock/workspace');
    });

    it('does not cache when user cancels input box', async () => {
      mockInputBox(undefined, undefined);

      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('does not cache when user provides empty path', async () => {
      mockInputBox('   ', undefined);

      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: No repository path provided.',
      );
    });

    it('does not cache when path is not a git repository', async () => {
      mockInputBox('/not/a/repo', undefined);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: "/not/a/repo" is not a git repository.',
      );
    });

    it('isolates cache by repo key — repo A does not prefill for repo B', async () => {
      mockMemento._store.set('repoPath:owner/repoA', '/path/to/repoA');

      const item = createWorkItem({ externalId: 'owner/repoB#456' });
      await action.run(item);

      expect(window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: '' }),
      );
    });

    it('same repo prefills across different issues', async () => {
      mockMemento._store.set('repoPath:owner/repo', '/cached/path');
      mockInputBox('/cached/path', 'origin/dev');

      const item1 = createWorkItem({ externalId: 'owner/repo#100' });
      await action.run(item1);

      vi.clearAllMocks();
      mockInputBox('/cached/path', 'origin/dev');
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, { stdout: '', stderr: '' }, '');
      }) as any);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().endsWith('.git'));

      const item2 = createWorkItem({ externalId: 'owner/repo#200' });
      await action.run(item2);

      expect(window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: '/cached/path' }),
      );
    });
  });

  describe('run', () => {
    it('creates branch and worktree with correct names', async () => {
      const item = createWorkItem({ title: '#123: Fix login redirect bug' });
      await action.run(item);

      expect(execFile).toHaveBeenCalledTimes(3);

      // First call: check if branch exists
      const firstCall = vi.mocked(execFile).mock.calls[0];
      expect(firstCall[0]).toBe('git');
      expect(firstCall[1]).toEqual(['branch', '--list', 'issue123']);
      expect(firstCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Second call: create branch from user-specified base
      const secondCall = vi.mocked(execFile).mock.calls[1];
      expect(secondCall[0]).toBe('git');
      expect(secondCall[1]).toEqual(['branch', 'issue123', 'origin/dev']);
      expect(secondCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Third call: create worktree
      const thirdCall = vi.mocked(execFile).mock.calls[2];
      expect(thirdCall[0]).toBe('git');
      expect(thirdCall[1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'workspace-issue123'),
        'issue123',
      ]);
    });

    it('uses user-specified base branch for branch creation', async () => {
      mockInputBox('/mock/workspace', 'main');

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      const branchCall = vi.mocked(execFile).mock.calls.find(
        call => call[1]![0] === 'branch' && call[1]![1] !== '--list'
      );
      expect(branchCall![1]).toEqual(['branch', 'issue123', 'main']);
    });

    it('opens new VS Code window at worktree path', async () => {
      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(Uri.file).toHaveBeenCalledWith(path.join('/mock', 'workspace-issue123'));
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
        'WorkCenter: Created worktree for issue123',
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
          cb(null, { stdout: 'issue123\n', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: Branch "issue123" already exists.',
      );
      // Should not attempt to create branch or worktree
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    it('shows error and deletes branch when worktree directory already exists', async () => {
      // Mock git worktree add to fail because directory already exists
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'worktree') {
          const stderr = `fatal: '${path.join('/mock', 'workspace-issue123')}' already exists`;
          const err = new Error(
            `Command failed: git worktree add ${path.join('/mock', 'workspace-issue123')} issue123\n${stderr}`
          );
          (err as any).stderr = stderr;
          cb(err, '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        `WorkCenter: Directory "${path.join('/mock', 'workspace-issue123')}" already exists.`,
      );
      // Should delete the branch (rollback)
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['branch', '-D', 'issue123'],
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

      const calls = vi.mocked(execFile).mock.calls;
      const worktreeIdx = calls.findIndex(c => c[1]![0] === 'worktree');
      const rollbackIdx = calls.findIndex(c => c[1]![0] === 'branch' && c[1]![1] === '-D');

      expect(worktreeIdx).toBeGreaterThan(-1);
      expect(rollbackIdx).toBeGreaterThan(-1);
      // Rollback must happen after worktree add
      expect(rollbackIdx).toBeGreaterThan(worktreeIdx);

      expect(calls[rollbackIdx][1]).toEqual(['branch', '-D', 'issue123']);
      expect(calls[rollbackIdx][2]).toEqual({ cwd: '/mock/workspace' });
    });
  });

  describe('base branch prompting', () => {
    it('prompts user for base branch with no default on first use', async () => {
      const item = createWorkItem();
      await action.run(item);

      // Second showInputBox call is for base branch
      expect(window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Enter the base branch for owner/repo',
        value: '',
        ignoreFocusOut: true,
      });
    });

    it('pre-fills cached base branch as default on subsequent use', async () => {
      mockMemento._store.set('baseBranch:owner/repo', 'origin/main');
      mockInputBox('/mock/workspace', 'origin/main');

      const item = createWorkItem();
      await action.run(item);

      expect(window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Enter the base branch for owner/repo',
          value: 'origin/main',
        }),
      );
    });

    it('caches the selected base branch on success', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).toHaveBeenCalledWith('baseBranch:owner/repo', 'origin/dev');
    });

    it('does not cache when user cancels base branch input', async () => {
      mockInputBox('/mock/workspace', undefined);

      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).toHaveBeenCalledWith('repoPath:owner/repo', '/mock/workspace');
      expect(mockMemento.update).not.toHaveBeenCalledWith('baseBranch:owner/repo', expect.anything());
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when user provides empty base branch', async () => {
      mockInputBox('/mock/workspace', '  ');

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'WorkCenter: No base branch provided.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('isolates cache by repo key', async () => {
      mockMemento._store.set('baseBranch:owner/repoA', 'develop');

      const item = createWorkItem({ externalId: 'owner/repoB#456' });
      await action.run(item);

      // Base branch prompt should have empty default (not 'develop')
      const baseBranchCall = vi.mocked(window.showInputBox).mock.calls.find(
        call => (call[0] as any)?.prompt?.includes('base branch'),
      );
      expect(baseBranchCall).toBeDefined();
      expect((baseBranchCall![0] as any).value).toBe('');
    });
  });

  describe('error scenarios', () => {
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

      expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to delete branch during rollback.*branch delete failed: ref not found/),
      );

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

    it('shows warning when worktree fails and branch rollback also fails', async () => {
      const item = createWorkItem({ externalId: 'invalid-format' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine issue number.',
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when git branch creation command fails', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] !== '--list') {
          cb(new Error('fatal: not a valid object name'), '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('fatal: not a valid object name'),
      );
    });

    it('handles worktree directory check when branch was already created', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        // Simulate git worktree add failing because directory already exists
        if (args[0] === 'worktree' && args[1] === 'add') {
          const err = new Error("fatal: 'issue123' already exists");
          (err as any).stderr = "'issue123' already exists";
          cb(err, '', '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      // Should show directory-exists error
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
      // Should have cleaned up the branch
      const deleteCalls = vi.mocked(execFile).mock.calls.filter(
        call => call[1]![0] === 'branch' && call[1]![1] === '-D'
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace } from 'vscode';
import { StartWorkAction } from '../startWorkAction';
import * as path from 'path';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], optsOrCb: any, cb?: Function) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    callback?.(null, '', '');
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

    // Default: no post-worktree commands configured
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => defaultValue),
    } as any);

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

    it('returns true for ado-work-items provider items in InProgress state', () => {
      const item = createWorkItem({ providerId: 'ado-work-items', state: 'InProgress', externalId: 'org/project/456' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns false for non-supported provider items', () => {
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
        'DevDocket: No repository path provided.',
      );
    });

    it('does not cache when path is not a git repository', async () => {
      mockInputBox('/not/a/repo', undefined);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: "/not/a/repo" is not a git repository.',
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
    it('creates branch and worktree with correct names for GitHub items', async () => {
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

    it('creates branch and worktree with correct names for ADO items', async () => {
      const item = createWorkItem({
        providerId: 'ado-work-items',
        externalId: 'org/project/456',
        title: 'ADO work item 456',
      });
      await action.run(item);

      expect(execFile).toHaveBeenCalledTimes(3);

      // First call: check if branch exists
      const firstCall = vi.mocked(execFile).mock.calls[0];
      expect(firstCall[0]).toBe('git');
      expect(firstCall[1]).toEqual(['branch', '--list', 'issue456']);
      expect(firstCall[2]).toEqual({ cwd: '/mock/workspace' });

      // Second call: create branch
      const secondCall = vi.mocked(execFile).mock.calls[1];
      expect(secondCall[0]).toBe('git');
      expect(secondCall[1]).toEqual(['branch', 'issue456', 'origin/dev']);

      // Third call: create worktree
      const thirdCall = vi.mocked(execFile).mock.calls[2];
      expect(thirdCall[0]).toBe('git');
      expect(thirdCall[1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'workspace-issue456'),
        'issue456',
      ]);
    });

    it('uses user-specified base branch for branch creation', async () => {
      mockInputBox('/mock/workspace', 'main');

      const item = createWorkItem({ title: '#123: Fix bug' });
      await action.run(item);

      const branchCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'branch' && call[1]?.[1] !== '--list',
      );
      expect(branchCall).toBeDefined();
      expect(branchCall![1]).toEqual(['branch', 'issue123', 'main']);
    });

    it('shows error when branch already exists', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: '  issue123\n', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Branch "issue123" already exists.',
      );
    });

    it('shows error when worktree directory already exists', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pathStr = p.toString();
        // .git check passes, worktree dir check also passes (already exists)
        return pathStr.endsWith('.git') || pathStr.includes('workspace-issue123');
      });

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
      // Should not have created any branches (fail-fast before git operations)
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when externalId is missing', async () => {
      const item = createWorkItem({ externalId: undefined });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine issue number.',
      );
    });

    it('shows error when externalId format is invalid', async () => {
      const item = createWorkItem({ externalId: 'invalid-format' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine issue number.',
      );
    });

    it('shows success message after creating worktree', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Created worktree for issue123',
      );
    });

    it('stores git work metadata in globalState after creating worktree', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).toHaveBeenCalledWith(
        'gitWork:wc-test-1',
        {
          branchName: 'issue123',
          worktreePath: path.join('/mock', 'workspace-issue123'),
          repoPath: '/mock/workspace',
        },
      );
    });

    it('does not store metadata when worktree creation fails', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'worktree') {
          cb(new Error('worktree failed'), { stdout: '', stderr: '' }, '');
          return;
        }
        cb(null, { stdout: '', stderr: '' }, '');
      }) as any);

      const item = createWorkItem();
      await action.run(item);

      // Should not have stored gitWork metadata (repoPath and baseBranch caching still happens)
      expect(mockMemento.update).not.toHaveBeenCalledWith(
        'gitWork:wc-test-1',
        expect.anything(),
      );
    });

    it('runs post-worktree commands with {path} placeholder', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'commands') {
            return [
              { command: 'npm', args: ['install', '--prefix', '{path}'] },
            ];
          }
          return defaultValue;
        }),
      } as any);

      const item = createWorkItem();
      await action.run(item);

      // git commands (3) + 1 post-worktree command
      expect(execFile).toHaveBeenCalledTimes(4);
      const postCmd = vi.mocked(execFile).mock.calls[3];
      expect(postCmd[0]).toBe('npm');
      const expectedWorktreePath = path.join('/mock', 'workspace-issue123');
      expect(postCmd[1]).toEqual(['install', '--prefix', expectedWorktreePath]);
    });

    it('shows warning when post-worktree command fails', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'commands') {
            return [{ command: 'bad-cmd' }];
          }
          return defaultValue;
        }),
      } as any);

      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], optsOrCb: any, cb?: Function) => {
        const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
        if (cmd === 'bad-cmd') {
          callback?.(new Error('command not found'), { stdout: '', stderr: '' }, '');
          return;
        }
        callback?.(null, { stdout: '', stderr: '' }, '');
      }) as any);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('bad-cmd'),
      );
    });

    it('handles git worktree failure and rolls back branch', async () => {
      let callCount = 0;
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        callCount++;
        if (args[0] === 'worktree') {
          cb(new Error('worktree failed'), { stdout: '', stderr: '' }, '');
          return;
        }
        cb(null, { stdout: '', stderr: '' }, '');
      }) as any);

      const item = createWorkItem();
      await action.run(item);

      // Should have attempted rollback (branch -D)
      const rollbackCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'branch' && call[1]?.[1] === '-D',
      );
      expect(rollbackCall).toBeDefined();
      expect(rollbackCall![1]).toEqual(['branch', '-D', 'issue123']);
    });
  });

  describe('base branch prompting', () => {
    it('prompts user for base branch with no default on first use', async () => {
      const item = createWorkItem();
      await action.run(item);

      const baseBranchCall = vi.mocked(window.showInputBox).mock.calls.find(
        (call: any[]) => call[0]?.prompt?.includes('base branch'),
      );
      expect(baseBranchCall).toBeDefined();
      expect(baseBranchCall![0]).toEqual({
        prompt: 'Enter the base branch for owner/repo',
        value: '',
        ignoreFocusOut: true,
      });
    });

    it('pre-fills cached branch as default on subsequent use', async () => {
      mockMemento._store.set('baseBranch:owner/repo', 'origin/main');
      mockInputBox('/mock/workspace', 'origin/main');

      const item = createWorkItem();
      await action.run(item);

      const baseBranchCall = vi.mocked(window.showInputBox).mock.calls.find(
        (call: any[]) => call[0]?.prompt?.includes('base branch'),
      );
      expect(baseBranchCall![0]).toEqual(
        expect.objectContaining({ value: 'origin/main' }),
      );
    });

    it('caches the selected base branch on success', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockMemento.update).toHaveBeenCalledWith('baseBranch:owner/repo', 'origin/dev');
    });

    it('does not proceed when user cancels base branch input', async () => {
      mockInputBox('/mock/workspace', undefined);

      const item = createWorkItem();
      await action.run(item);

      // Should have cached repo path but not proceeded to git commands
      expect(mockMemento.update).toHaveBeenCalledTimes(1); // only repoPath
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when user provides empty base branch', async () => {
      mockInputBox('/mock/workspace', '   ');

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: No base branch provided.',
      );
    });
  });

  describe('ADO-specific behavior', () => {
    it('parses ADO externalId org/project/456 correctly', async () => {
      const item = createWorkItem({
        providerId: 'ado-work-items',
        externalId: 'org/project/456',
      });
      await action.run(item);

      // Repo path prompt should use repoKey "org/project"
      expect(window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Enter the local path to the git repository for org/project',
        }),
      );
    });

    it('creates branch issue456 for ADO items', async () => {
      const item = createWorkItem({
        providerId: 'ado-work-items',
        externalId: 'org/project/456',
      });
      await action.run(item);

      const branchListCall = vi.mocked(execFile).mock.calls[0];
      expect(branchListCall[1]).toEqual(['branch', '--list', 'issue456']);
    });

    it('creates worktree dir workspace-issue456 for ADO items', async () => {
      const item = createWorkItem({
        providerId: 'ado-work-items',
        externalId: 'org/project/456',
      });
      await action.run(item);

      const worktreeCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'worktree',
      );
      expect(worktreeCall).toBeDefined();
      expect(worktreeCall![1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'workspace-issue456'),
        'issue456',
      ]);
    });

    it('caches repo path per ADO repoKey', async () => {
      const item = createWorkItem({
        providerId: 'ado-work-items',
        externalId: 'org/project/456',
      });
      await action.run(item);

      expect(mockMemento.update).toHaveBeenCalledWith('repoPath:org/project', '/mock/workspace');
    });
  });

  describe('error scenarios', () => {
    it('handles generic git failure gracefully', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] !== '--list') {
          cb(new Error('git error: permission denied'), { stdout: '', stderr: '' }, '');
          return;
        }
        cb(null, { stdout: '', stderr: '' }, '');
      }) as any);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start work'),
      );
    });
  });
});

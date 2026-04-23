import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace, authentication } from 'vscode';
import { StartWorkAction } from '../startWorkAction';
import * as path from 'path';

// Mock child_process with custom promisify so util.promisify(execFile) returns { stdout, stderr }
vi.mock('child_process', () => {
  const fn = vi.fn((cmd: string, args: string[], optsOrCb: any, cb?: Function) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    callback?.(null, '', '');
  });
  const customSymbol = Symbol.for('nodejs.util.promisify.custom');
  (fn as any)[customSymbol] = (...promiseArgs: any[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const cb = (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      };
      // Determine if last user arg is options or if there are only positional args
      const lastArg = promiseArgs[promiseArgs.length - 1];
      if (typeof lastArg === 'object' && lastArg !== null) {
        fn(...promiseArgs, cb);
      } else {
        fn(...promiseArgs, cb);
      }
    });
  };
  return { execFile: fn };
});

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

/** Sets up showQuickPick to return the worktree option (default for existing tests). */
function mockQuickPickWorktree() {
  vi.mocked(window.showQuickPick).mockResolvedValue({ label: 'Create worktree', value: 'worktree' } as any);
}

/** Sets up showQuickPick to return the checkout option. */
function mockQuickPickCheckout() {
  vi.mocked(window.showQuickPick).mockResolvedValue({ label: 'Checkout branch', value: 'checkout' } as any);
}

/** Mocks execFile to fail for local branch existence checks (rev-parse --verify refs/heads/*). */
function mockNoLocalBranch() {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
      cb(new Error('not a valid ref'), '', '');
      return;
    }
    cb(null, '', '');
  }) as any);
}

function mockFetchResponse(body: any, status = 200) {
  const mockResponse = {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
}

function createGitHubPrResponse(overrides: Partial<any> = {}) {
  return {
    head: {
      ref: 'feature/my-branch',
      repo: {
        full_name: 'owner/repo',
        clone_url: 'https://github.com/owner/repo.git',
      },
    },
    base: {
      repo: {
        full_name: 'owner/repo',
      },
    },
    ...overrides,
  };
}

describe('StartWorkAction', () => {
  let action: StartWorkAction;
  let mockMemento: ReturnType<typeof createMockMemento>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockMemento = createMockMemento();
    action = new StartWorkAction(mockMemento as any);

    // Default: showInputBox returns repo path and base branch based on prompt
    mockInputBox('/mock/workspace', 'origin/dev');

    // Default: select worktree mode (preserves existing test behavior)
    mockQuickPickWorktree();

    // Default: no post-worktree commands configured
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => defaultValue),
    } as any);

    // Reset execFile mock to succeed with empty output
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      cb(null, '', '');
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

    it('returns true for github-my-prs provider items in InProgress state', () => {
      const item = createWorkItem({ providerId: 'github-my-prs', state: 'InProgress' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for github-pr-reviews provider items in InProgress state', () => {
      const item = createWorkItem({ providerId: 'github-pr-reviews', state: 'InProgress' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for ado-pr-reviews provider items in InProgress state', () => {
      const item = createWorkItem({ providerId: 'ado-pr-reviews', state: 'InProgress', externalId: 'org/project/repo/101' });
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
      mockQuickPickWorktree();
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, '', '');
      }) as any);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().endsWith('.git'));

      const item2 = createWorkItem({ externalId: 'owner/repo#200' });
      await action.run(item2);

      expect(window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: '/cached/path' }),
      );
    });
  });

  describe('checkout vs worktree prompt', () => {
    it('shows quick pick with checkout and worktree options for issue items', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showQuickPick).toHaveBeenCalledWith(
        [
          { label: 'Checkout branch', value: 'checkout' },
          { label: 'Create worktree', value: 'worktree' },
        ],
        {
          placeHolder: 'How would you like to work on this?',
          ignoreFocusOut: true,
        },
      );
    });

    it('aborts when user cancels work mode selection', async () => {
      vi.mocked(window.showQuickPick).mockResolvedValue(undefined);

      const item = createWorkItem();
      await action.run(item);

      expect(execFile).not.toHaveBeenCalled();
    });
  });

  describe('run (worktree mode)', () => {
    it('creates branch and worktree with correct names for GitHub items', async () => {
      const item = createWorkItem({ title: '#123: Fix login redirect bug' });
      await action.run(item);

      expect(execFile).toHaveBeenCalledTimes(3);

      // First call: check if branch exists
      const firstCall = vi.mocked(execFile).mock.calls[0];
      expect(firstCall[0]).toBe('git');
      expect(firstCall[1]).toEqual(['branch', '--list', 'issue123']);
      expect(firstCall[2]).toEqual({ cwd: '/mock/workspace', timeout: 30_000 });

      // Second call: create branch from user-specified base
      const secondCall = vi.mocked(execFile).mock.calls[1];
      expect(secondCall[0]).toBe('git');
      expect(secondCall[1]).toEqual(['branch', 'issue123', 'origin/dev']);
      expect(secondCall[2]).toEqual({ cwd: '/mock/workspace', timeout: 30_000 });

      // Third call: create worktree
      const thirdCall = vi.mocked(execFile).mock.calls[2];
      expect(thirdCall[0]).toBe('git');
      expect(thirdCall[1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'workspace-issue123'),
        'issue123',
      ]);
      expect(thirdCall[2]).toEqual({ cwd: '/mock/workspace', timeout: 30_000 });
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
      expect(firstCall[2]).toEqual({ cwd: '/mock/workspace', timeout: 30_000 });

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
      expect(thirdCall[2]).toEqual({ cwd: '/mock/workspace', timeout: 30_000 });
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
          cb(null, '  issue123\n', '');
        } else {
          cb(null, '', '');
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
        'Could not determine work item number.',
      );
    });

    it('shows error when externalId format is invalid', async () => {
      const item = createWorkItem({ externalId: 'invalid-format' });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Could not determine work item number.',
      );
    });

    it('shows success message after creating worktree', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Created worktree for issue123',
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
      expect(postCmd[2]).toEqual({ cwd: expectedWorktreePath, timeout: 60_000 });
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
          callback?.(new Error('command not found'), '', '');
          return;
        }
        callback?.(null, '', '');
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
          cb(new Error('worktree failed'), '', '');
          return;
        }
        cb(null, '', '');
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

    it('logs activity with worktreePath and repoPath', async () => {
      const { commands } = await import('vscode');
      const item = createWorkItem();
      await action.run(item);

      const expectedWorktreePath = path.join('/mock', 'workspace-issue123');
      expect(commands.executeCommand).toHaveBeenCalledWith(
        'devdocket.addActivity',
        item.id,
        'work-started',
        JSON.stringify({ branchName: 'issue123', worktreePath: expectedWorktreePath, repoPath: '/mock/workspace' }),
      );
    });
  });

  describe('run (checkout mode)', () => {
    beforeEach(() => {
      mockQuickPickCheckout();
    });

    it('checks out new branch with git checkout -b for issue items', async () => {
      const item = createWorkItem();
      await action.run(item);

      // git status --porcelain + git checkout -b
      expect(execFile).toHaveBeenCalledTimes(2);

      const statusCall = vi.mocked(execFile).mock.calls[0];
      expect(statusCall[1]).toEqual(['status', '--porcelain']);

      const checkoutCall = vi.mocked(execFile).mock.calls[1];
      expect(checkoutCall[0]).toBe('git');
      expect(checkoutCall[1]).toEqual(['checkout', '-b', 'issue123', 'origin/dev']);
      expect(checkoutCall[2]).toEqual({ cwd: '/mock/workspace', timeout: 30_000 });
    });

    it('shows success message after checkout', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Checked out branch issue123',
      );
    });

    it('logs activity with branchName and repoPath (no worktreePath)', async () => {
      const { commands } = await import('vscode');
      const item = createWorkItem();
      await action.run(item);

      expect(commands.executeCommand).toHaveBeenCalledWith(
        'devdocket.addActivity',
        item.id,
        'work-started',
        JSON.stringify({ branchName: 'issue123', repoPath: '/mock/workspace' }),
      );
    });

    it('prompts confirmation when working tree is dirty', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'status' && args[1] === '--porcelain') {
          cb(null, ' M file.ts\n', '');
          return;
        }
        cb(null, '', '');
      }) as any);

      vi.mocked(window.showWarningMessage).mockResolvedValue('Yes' as any);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'Working tree has uncommitted changes. Checkout anyway?',
        { modal: true },
        'Yes',
      );
      // Should still proceed
      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeDefined();
    });

    it('aborts checkout when user declines dirty tree prompt', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'status' && args[1] === '--porcelain') {
          cb(null, ' M file.ts\n', '');
          return;
        }
        cb(null, '', '');
      }) as any);

      vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as any);

      const item = createWorkItem();
      await action.run(item);

      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeUndefined();
    });

    it('does not prompt when working tree is clean', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showWarningMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('uncommitted changes'),
        expect.anything(),
        expect.anything(),
      );
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
          cb(new Error('git error: permission denied'), '', '');
          return;
        }
        cb(null, '', '');
      }) as any);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start work'),
      );
    });
  });

  describe('GitHub PR flow', () => {
    beforeEach(() => {
      mockFetchResponse(createGitHubPrResponse());
    });

    it('fetches PR branch via GitHub API for github-my-prs items', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      expect(authentication.getSession).toHaveBeenCalledWith('github', ['repo'], { createIfNone: true });
      const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
      expect(fetchCalls[0][0]).toBe('https://api.github.com/repos/owner/repo/pulls/42');
    });

    it('fetches PR branch via GitHub API for github-pr-reviews items', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'github-pr-reviews',
        externalId: 'owner/repo#99',
      });
      await action.run(item);

      const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
      expect(fetchCalls[0][0]).toBe('https://api.github.com/repos/owner/repo/pulls/99');
    });

    it('does not prompt for base branch for PR items', async () => {
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const baseBranchCall = vi.mocked(window.showInputBox).mock.calls.find(
        (call: any[]) => call[0]?.prompt?.includes('base branch'),
      );
      expect(baseBranchCall).toBeUndefined();
    });

    it('fetches from origin for same-repo PRs', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const fetchCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'fetch',
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toEqual(['fetch', 'origin', 'feature/my-branch']);
    });

    it('adds fork remote and fetches for fork PRs', async () => {
      mockFetchResponse(createGitHubPrResponse({
        head: {
          ref: 'fix/something',
          repo: {
            full_name: 'contributor/repo',
            clone_url: 'https://github.com/contributor/repo.git',
          },
        },
      }));
      mockQuickPickWorktree();
      mockNoLocalBranch();

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const remoteAddCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'remote' && call[1]?.[1] === 'add',
      );
      expect(remoteAddCall).toBeDefined();
      expect(remoteAddCall![1]).toEqual(['remote', 'add', 'devdocket-fork-contributor', 'https://github.com/contributor/repo.git']);

      const fetchCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'fetch',
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toEqual(['fetch', 'devdocket-fork-contributor', 'fix/something']);

      const worktreeCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'worktree',
      );
      expect(worktreeCall).toBeDefined();
      expect(worktreeCall![1]).toEqual([
        'worktree', 'add', '-b', 'fix/something',
        path.join('/mock', 'workspace-pr42'),
        'devdocket-fork-contributor/fix/something',
      ]);
    });

    it('creates detached worktree from tracking ref when local branch exists (fork PR)', async () => {
      mockFetchResponse(createGitHubPrResponse({
        head: {
          ref: 'fix/something',
          repo: {
            full_name: 'contributor/repo',
            clone_url: 'https://github.com/contributor/repo.git',
          },
        },
      }));
      mockQuickPickWorktree();
      // Local branch exists — should create detached worktree from tracking ref

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const worktreeCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'worktree',
      );
      expect(worktreeCall).toBeDefined();
      expect(worktreeCall![1]).toEqual([
        'worktree', 'add', '--detach',
        path.join('/mock', 'workspace-pr42'),
        'devdocket-fork-contributor/fix/something',
      ]);
    });

    it('uses checkout -b with tracking ref for fork PRs in checkout mode', async () => {
      mockFetchResponse(createGitHubPrResponse({
        head: {
          ref: 'fix/something',
          repo: {
            full_name: 'contributor/repo',
            clone_url: 'https://github.com/contributor/repo.git',
          },
        },
      }));
      mockQuickPickCheckout();
      mockNoLocalBranch();

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![1]).toEqual(['checkout', '-b', 'fix/something', 'devdocket-fork-contributor/fix/something']);
    });

    it('uses detached checkout for fork PR when local branch exists', async () => {
      mockFetchResponse(createGitHubPrResponse({
        head: {
          ref: 'fix/something',
          repo: {
            full_name: 'contributor/repo',
            clone_url: 'https://github.com/contributor/repo.git',
          },
        },
      }));
      mockQuickPickCheckout();
      // Local branch exists — should use --detach to avoid resetting user's branch
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![1]).toEqual(['checkout', '--detach', 'devdocket-fork-contributor/fix/something']);
    });

    it('shows error when fork repository has been deleted', async () => {
      mockFetchResponse(createGitHubPrResponse({
        head: {
          ref: 'fix/something',
          repo: null,
        },
      }));
      mockQuickPickWorktree();

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: The source repository for PR #42 has been deleted.',
      );
    });

    it('handles existing fork remote gracefully', async () => {
      mockFetchResponse(createGitHubPrResponse({
        head: {
          ref: 'fix/something',
          repo: {
            full_name: 'contributor/repo',
            clone_url: 'https://github.com/contributor/repo.git',
          },
        },
      }));
      mockQuickPickWorktree();

      // Make remote add fail (already exists); get-url returns the same URL
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'remote' && args[1] === 'add') {
          cb(new Error('remote devdocket-fork-contributor already exists'), '', '');
          return;
        }
        if (args[0] === 'remote' && args[1] === 'get-url') {
          cb(null, 'https://github.com/contributor/repo.git\n', '');
          return;
        }
        cb(null, '', '');
      }) as any);

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      // Should still fetch
      const fetchCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'fetch',
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toEqual(['fetch', 'devdocket-fork-contributor', 'fix/something']);
    });

    it('creates worktree with pr-prefixed directory name', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const worktreeCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'worktree',
      );
      expect(worktreeCall).toBeDefined();
      expect(worktreeCall![1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'workspace-pr42'),
        'feature/my-branch',
      ]);
    });

    it('checks out PR branch for checkout mode', async () => {
      mockQuickPickCheckout();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![1]).toEqual(['checkout', 'feature/my-branch']);
    });

    it('creates local branch from origin when no local branch exists (worktree)', async () => {
      mockQuickPickWorktree();
      mockNoLocalBranch();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const worktreeCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'worktree',
      );
      expect(worktreeCall).toBeDefined();
      expect(worktreeCall![1]).toEqual([
        'worktree', 'add', '-b', 'feature/my-branch',
        path.join('/mock', 'workspace-pr42'),
        'origin/feature/my-branch',
      ]);
    });

    it('creates local branch from origin when no local branch exists (checkout)', async () => {
      mockQuickPickCheckout();
      mockNoLocalBranch();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![1]).toEqual(['checkout', '-b', 'feature/my-branch', '--track', 'origin/feature/my-branch']);
    });

    it('shows error for 404 PR response', async () => {
      mockFetchResponse({}, 404);
      mockQuickPickWorktree();

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#999',
      });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Could not find PR #999',
      );
    });

    it('shows error for non-404 API errors', async () => {
      mockFetchResponse({}, 500);
      mockQuickPickWorktree();

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: GitHub API error (500)',
      );
    });

    it('logs activity with worktreePath for worktree mode', async () => {
      const { commands } = await import('vscode');
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      const expectedWorktreePath = path.join('/mock', 'workspace-pr42');
      expect(commands.executeCommand).toHaveBeenCalledWith(
        'devdocket.addActivity',
        item.id,
        'work-started',
        JSON.stringify({ worktreePath: expectedWorktreePath, repoPath: '/mock/workspace' }),
      );
    });

    it('logs activity without worktreePath for checkout mode', async () => {
      const { commands } = await import('vscode');
      mockQuickPickCheckout();
      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      expect(commands.executeCommand).toHaveBeenCalledWith(
        'devdocket.addActivity',
        item.id,
        'work-started',
        JSON.stringify({ repoPath: '/mock/workspace' }),
      );
    });

    it('prompts for dirty tree before checkout', async () => {
      mockQuickPickCheckout();
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'status' && args[1] === '--porcelain') {
          cb(null, ' M dirty.ts\n', '');
          return;
        }
        cb(null, '', '');
      }) as any);
      vi.mocked(window.showWarningMessage).mockResolvedValue('Yes' as any);

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'Working tree has uncommitted changes. Checkout anyway?',
        { modal: true },
        'Yes',
      );
    });

    it('aborts when user cancels work mode selection for PR', async () => {
      vi.mocked(window.showQuickPick).mockResolvedValue(undefined);

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      // fetch should not have been called (work mode prompt comes before API call)
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('shows error when worktree dir already exists for PR', async () => {
      mockQuickPickWorktree();
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pathStr = p.toString();
        return pathStr.endsWith('.git') || pathStr.includes('workspace-pr42');
      });

      const item = createWorkItem({
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
      });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
    });
  });

  describe('ADO PR flow', () => {
    beforeEach(() => {
      mockFetchResponse({ sourceRefName: 'refs/heads/feature/ado-branch' });
    });

    it('fetches PR branch via ADO API for ado-pr-reviews items', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'ado-pr-reviews',
        externalId: 'org/project/repo/101',
      });
      await action.run(item);

      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { createIfNone: true },
      );
      const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
      expect(fetchCalls[0][0]).toBe(
        'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullrequests/101?api-version=7.1',
      );
    });

    it('strips refs/heads/ prefix from sourceRefName', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'ado-pr-reviews',
        externalId: 'org/project/repo/101',
      });
      await action.run(item);

      const fetchCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'fetch',
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toEqual(['fetch', 'origin', 'feature/ado-branch']);
    });

    it('creates worktree with pr-prefixed directory for ADO PRs', async () => {
      mockQuickPickWorktree();
      const item = createWorkItem({
        providerId: 'ado-pr-reviews',
        externalId: 'org/project/repo/101',
      });
      await action.run(item);

      const worktreeCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'worktree',
      );
      expect(worktreeCall).toBeDefined();
      expect(worktreeCall![1]).toEqual([
        'worktree', 'add',
        path.join('/mock', 'workspace-pr101'),
        'feature/ado-branch',
      ]);
    });

    it('checks out ADO PR branch for checkout mode', async () => {
      mockQuickPickCheckout();
      const item = createWorkItem({
        providerId: 'ado-pr-reviews',
        externalId: 'org/project/repo/101',
      });
      await action.run(item);

      const checkoutCall = vi.mocked(execFile).mock.calls.find(
        (call: any[]) => call[1]?.[0] === 'checkout',
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![1]).toEqual(['checkout', 'feature/ado-branch']);
    });

    it('shows error for 404 ADO PR response', async () => {
      mockFetchResponse({}, 404);
      mockQuickPickWorktree();

      const item = createWorkItem({
        providerId: 'ado-pr-reviews',
        externalId: 'org/project/repo/999',
      });
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'DevDocket: Could not find PR #999',
      );
    });
  });
});

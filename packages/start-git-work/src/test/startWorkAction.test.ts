import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace } from 'vscode';
import { StartWorkAction } from '../startWorkAction';
import * as path from 'path';
import type { ProviderItemCapabilities } from '@devdocket/shared';

vi.mock('child_process', () => {
  const fn = vi.fn((cmd: string, args: string[], optsOrCb: any, cb?: Function) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    callback?.(null, '', '');
  });
  const customSymbol = Symbol.for('nodejs.util.promisify.custom');
  (fn as any)[customSymbol] = (...promiseArgs: any[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const cb = (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };
    fn(...promiseArgs, cb);
  });
  return { execFile: fn };
});

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));

import { execFile } from 'child_process';
import * as fs from 'fs';

const ORIGIN_REMOTE_V = 'origin\thttps://example.com/acme/repo.git (fetch)\norigin\thttps://example.com/acme/repo.git (push)\n';

type GitWork = NonNullable<ProviderItemCapabilities['gitWork']>;

function createWorkItem(overrides: Partial<any> = {}) {
  return {
    id: 'wc-test-1',
    title: 'Test item',
    state: 'InProgress',
    providerId: 'provider',
    externalId: 'item-1',
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

function createAction(items: Record<string, { capabilities?: { gitWork?: GitWork } }> = {}) {
  const memento = createMockMemento();
  const action = new StartWorkAction(memento as any, (providerId, externalId) => items[`${providerId}:${externalId}`] as any);
  return { action, memento };
}

function discovered(providerId: string, externalId: string, gitWork?: GitWork) {
  return { [`${providerId}:${externalId}`]: { capabilities: gitWork ? { gitWork } : undefined } };
}

function mockInputBox(repoPath: string | undefined, baseBranch = 'origin/dev') {
  vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
    if (options?.prompt?.includes('local path')) {
      return repoPath;
    }
    if (options?.prompt?.includes('base branch')) {
      return baseBranch;
    }
    if (options?.title === 'DevDocket: Branch name' || options?.title === 'DevDocket: Worktree path') {
      return options.value;
    }
    return undefined;
  });
}

function setPromptForNames(enabled: boolean) {
  vi.mocked(workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue?: any) => key === 'devdocket.startGitWork.promptForNames' ? enabled : defaultValue),
  } as any);
}

function inputBoxOptions(title: string): any {
  const call = vi.mocked(window.showInputBox).mock.calls.find(([options]) => (options as any)?.title === title);
  return call?.[0];
}

function inputBoxInvocationOrder(title: string): number | undefined {
  const index = vi.mocked(window.showInputBox).mock.calls.findIndex(([options]) => (options as any)?.title === title);
  return index === -1 ? undefined : vi.mocked(window.showInputBox).mock.invocationCallOrder[index];
}

function isRepoPathPickItems(items: unknown): items is Array<{ pickKind?: string; repoPath?: string }> {
  return Array.isArray(items) && items.some(item => ['repo', 'paste', 'browse'].includes((item as { pickKind?: string }).pickKind ?? ''));
}

function isWorkModePickItems(items: unknown): boolean {
  return Array.isArray(items) && items.some(item => ['checkout', 'worktree'].includes((item as { value?: string }).value ?? ''));
}

function mockQuickPicks(repoPath = '/mock/workspace', workMode: 'checkout' | 'worktree' = 'worktree') {
  vi.mocked(window.showQuickPick).mockImplementation(async (items: any) => {
    if (isRepoPathPickItems(items)) {
      return items.find(item => item.pickKind === 'repo' && item.repoPath === repoPath)
        ?? items.find(item => item.pickKind === 'repo')
        ?? undefined;
    }
    if (isWorkModePickItems(items)) {
      return {
        label: workMode === 'worktree' ? 'Create worktree' : 'Checkout branch',
        value: workMode,
      } as any;
    }
    return undefined;
  });
}

function mockNoLocalBranch(remoteOutput = ORIGIN_REMOTE_V) {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
    if (args[0] === 'remote' && args[1] === '-v') {
      cb(null, remoteOutput, '');
      return;
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      cb(new Error('not a valid ref'), '', '');
      return;
    }
    cb(null, '', '');
  }) as any);
}

describe('StartWorkAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workspace as any).workspaceFolders = [{ uri: { fsPath: '/mock/workspace' } }];
    mockInputBox('/mock/workspace');
    mockQuickPicks();
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => defaultValue),
    } as any);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().endsWith('.git'));
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => cb(null, '', '')) as any);
  });

  describe('canRun', () => {
    it('returns true when a literal gitWork capability is present', () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      expect(action.canRun(item)).toBe(true);
    });

    it('returns true when a lazy gitWork capability is present', () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      })));

      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for a URL-imported GitHub issue when a synthetic provider item supplies gitWork', () => {
      const item = createWorkItem({ providerId: 'github', externalId: 'owner/repo#123' });
      const { action } = createAction(discovered('github', 'owner/repo#123', {
        kind: 'issue', cloneUrl: 'https://github.com/owner/repo.git', ref: 'issue123', repoLabel: 'owner/repo',
      }));

      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for a URL-imported GitHub PR when a synthetic provider item supplies gitWork', () => {
      const item = createWorkItem({ providerId: 'github-pr-reviews', externalId: 'owner/repo#42' });
      const { action } = createAction(discovered('github-pr-reviews', 'owner/repo#42', async () => ({
        kind: 'pr', cloneUrl: 'https://github.com/owner/repo.git', ref: 'feature/topic', repoLabel: 'owner/repo',
      })));

      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for a URL-imported ADO PR when a synthetic provider item supplies gitWork', () => {
      const item = createWorkItem({ providerId: 'ado-pr-reviews', externalId: 'myorg/MyProject/myrepo/42' });
      const { action } = createAction(discovered('ado-pr-reviews', 'myorg/MyProject/myrepo/42', async () => ({
        kind: 'pr', cloneUrl: 'https://myorg@dev.azure.com/myorg/MyProject/_git/myrepo', ref: 'users/me/fix', repoLabel: 'MyProject/myrepo',
      })));

      expect(action.canRun(item)).toBe(true);
    });

    it('returns false when no capability is present', () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1'));

      expect(action.canRun(item)).toBe(false);
    });

    it('returns false when the live discovered item is not found', () => {
      const item = createWorkItem();
      const { action } = createAction({});

      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for non-InProgress items', () => {
      const item = createWorkItem({ state: 'New' });
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      expect(action.canRun(item)).toBe(false);
    });
  });

  describe('run', () => {
    it('creates the provider-suggested branch for an issue', async () => {
      const item = createWorkItem({ providerId: 'fake-vendor', externalId: 'ABC-123' });
      const { action, memento } = createAction(discovered('fake-vendor', 'ABC-123', {
        kind: 'issue', cloneUrl: 'https://git.example.com/acme/repo.git', ref: 'vendor/ABC-123', repoLabel: 'Vendor Repo',
      }));

      await action.run(item);

      expect(execFile).toHaveBeenCalledTimes(3);
      expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(['branch', '--list', 'vendor/ABC-123']);
      expect(vi.mocked(execFile).mock.calls[1][1]).toEqual(['branch', 'vendor/ABC-123', 'origin/dev']);
      expect(vi.mocked(execFile).mock.calls[2][1]).toEqual([
        'worktree', 'add', path.join('/mock', 'Vendor-Repo-issue-123'), 'vendor/ABC-123',
      ]);
      expect(memento.update).toHaveBeenCalledWith('repoPath:Vendor Repo', '/mock/workspace');
    });

    it('does not duplicate the external id in the default issue worktree path', async () => {
      (workspace as any).workspaceFolders = [{ uri: { fsPath: '/mock/sdk' } }];
      mockQuickPicks('/mock/sdk');
      const item = createWorkItem({ externalId: 'dotnet/sdk#53921' });
      const { action } = createAction(discovered('provider', 'dotnet/sdk#53921', {
        kind: 'issue', cloneUrl: 'https://example.com/dotnet/sdk.git', ref: 'issue-53921-fix-foo', repoLabel: 'dotnet/sdk',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Worktree path')).toEqual(expect.objectContaining({
        value: path.join('/mock', 'sdk-issue-53921'),
      }));
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'worktree', 'add', path.join('/mock', 'sdk-issue-53921'), 'issue-53921-fix-foo',
      ]);
    });

    it('prompts for issue branch name and worktree path when promptForNames is enabled', async () => {
      const customWorktreePath = path.join('/mock', 'custom-worktree');
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.prompt?.includes('base branch')) {
          return 'origin/dev';
        }
        if (options?.title === 'DevDocket: Branch name') {
          return 'team/custom-branch';
        }
        if (options?.title === 'DevDocket: Worktree path') {
          return customWorktreePath;
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toEqual(expect.objectContaining({
        value: 'issue123',
        valueSelection: [0, 'issue123'.length],
      }));
      expect(inputBoxOptions('DevDocket: Worktree path')).toEqual(expect.objectContaining({
        value: path.join('/mock', 'repo-issue-1'),
      }));
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['branch', '--list', 'team/custom-branch'],
        ['branch', 'team/custom-branch', 'origin/dev'],
        ['worktree', 'add', customWorktreePath, 'team/custom-branch'],
      ]);
    });

    it('uses issue branch name and worktree path silently when promptForNames is disabled', async () => {
      setPromptForNames(false);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toBeUndefined();
      expect(inputBoxOptions('DevDocket: Worktree path')).toBeUndefined();
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['branch', '--list', 'issue123'],
        ['branch', 'issue123', 'origin/dev'],
        ['worktree', 'add', path.join('/mock', 'repo-issue-1'), 'issue123'],
      ]);
    });

    it('validates prompted branch names synchronously', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      const validateInput = inputBoxOptions('DevDocket: Branch name').validateInput;
      expect(validateInput('')).toBe('Branch name is required.');
      expect(validateInput('-bad')).toContain('valid git ref');
      expect(validateInput('bad..branch')).toContain('valid git ref');
      expect(validateInput('bad branch')).toContain('valid git ref');
      expect(validateInput('bad\nbranch')).toContain('valid git ref');
      expect(validateInput('refs/tags/v1')).toContain('branch ref');
      expect(validateInput('refs/heads/feature/good-branch')).toBeUndefined();
      expect(validateInput('feature/good-branch')).toBeUndefined();
    });

    it('validates prompted worktree paths synchronously', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      const validateInput = inputBoxOptions('DevDocket: Worktree path').validateInput;
      const outsideTarget = path.join(path.parse(process.cwd()).root, 'devdocket-test-worktrees', 'target');
      const outsideParent = path.dirname(outsideTarget);
      expect(validateInput('relative-worktree')).toBe('Worktree path must be absolute.');

      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(validateInput(outsideTarget)).toContain('does not exist');

      vi.mocked(fs.existsSync).mockImplementation((p: any) => path.resolve(p.toString()) === path.resolve(outsideParent));
      expect(validateInput(outsideTarget)).toBeUndefined();
      expect(validateInput(`  ${outsideTarget}  `)).toBeUndefined();

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const resolved = path.resolve(p.toString());
        return resolved === path.resolve(outsideParent) || resolved === path.resolve(outsideTarget);
      });
      expect(validateInput(outsideTarget)).toContain('already exists');

      const nestedTarget = path.join('/mock', 'workspace', 'nested-parent', 'target');
      const nestedParent = path.dirname(nestedTarget);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => path.resolve(p.toString()) === path.resolve(nestedParent));
      expect(validateInput(nestedTarget)).toBe('Worktree parent directory must not be inside the source repository.');

      const dotDotPrefixTarget = path.join('/mock', 'workspace', '..worktrees', 'target');
      const dotDotPrefixParent = path.dirname(dotDotPrefixTarget);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => path.resolve(p.toString()) === path.resolve(dotDotPrefixParent));
      expect(validateInput(dotDotPrefixTarget)).toBe('Worktree parent directory must not be inside the source repository.');
    });

    it('aborts without side effects when the branch-name prompt is cancelled', async () => {
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.prompt?.includes('base branch')) {
          return 'origin/dev';
        }
        if (options?.title === 'DevDocket: Branch name') {
          return undefined;
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(execFile).not.toHaveBeenCalled();
      expect(window.withProgress).not.toHaveBeenCalled();
    });

    it('aborts without side effects when the worktree-path prompt is cancelled', async () => {
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.prompt?.includes('base branch')) {
          return 'origin/dev';
        }
        if (options?.title === 'DevDocket: Worktree path') {
          return undefined;
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(execFile).not.toHaveBeenCalled();
      expect(window.withProgress).not.toHaveBeenCalled();
    });

    it('offers cached and git workspace folders before paste and browse choices', async () => {
      (workspace as any).workspaceFolders = [
        { uri: { fsPath: '/workspace/repo' } },
        { uri: { fsPath: '/workspace/not-git' } },
      ];
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().replace(/\\/g, '/').endsWith('/workspace/repo/.git'));
      mockQuickPicks('/workspace/repo');
      const item = createWorkItem();
      const { action, memento } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));
      memento._store.set('repoPath:acme/repo', '/cached/repo');

      await action.run(item);

      const repoPickItems = vi.mocked(window.showQuickPick).mock.calls[0]![0] as any[];
      expect(repoPickItems.map(item => item.label)).toEqual([
        '/cached/repo',
        '/workspace/repo',
        'Enter path manually…',
        'Browse…',
      ]);
      expect(memento.update).toHaveBeenCalledWith('repoPath:acme/repo', '/workspace/repo');
    });

    it('uses the selected folder from Browse for the repository path', async () => {
      vi.mocked(window.showQuickPick).mockImplementation(async (items: any) => {
        if (isRepoPathPickItems(items)) {
          return items.find(item => item.pickKind === 'browse');
        }
        if (isWorkModePickItems(items)) {
          return { label: 'Create worktree', value: 'worktree' } as any;
        }
        return undefined;
      });
      vi.mocked(window.showOpenDialog).mockResolvedValue([{ fsPath: '/chosen/repo' }] as any);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().replace(/\\/g, '/').endsWith('/chosen/repo/.git'));
      const item = createWorkItem();
      const { action, memento } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
        canSelectFolders: true,
        canSelectFiles: false,
      }));
      expect(memento.update).toHaveBeenCalledWith('repoPath:acme/repo', '/chosen/repo');
    });

    it('keeps manual entry as a legacy fallback', async () => {
      vi.mocked(window.showQuickPick).mockImplementation(async (items: any) => {
        if (isRepoPathPickItems(items)) {
          return items.find(item => item.pickKind === 'paste');
        }
        if (isWorkModePickItems(items)) {
          return { label: 'Create worktree', value: 'worktree' } as any;
        }
        return undefined;
      });
      mockInputBox('/pasted/repo');
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().replace(/\\/g, '/').endsWith('/pasted/repo/.git'));
      const item = createWorkItem();
      const { action, memento } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'Enter the local path to the git repository for acme/repo',
      }));
      expect(memento.update).toHaveBeenCalledWith('repoPath:acme/repo', '/pasted/repo');
    });

    it('re-prompts instead of erroring when the picked path is not a git repository', async () => {
      const item = createWorkItem();
      const { action, memento } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));
      memento._store.set('repoPath:acme/repo', '/invalid/repo');
      (workspace as any).workspaceFolders = [{ uri: { fsPath: '/valid/repo' } }];
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString().replace(/\\/g, '/').endsWith('/valid/repo/.git'));
      vi.mocked(window.showQuickPick).mockImplementation(async (items: any) => {
        if (isRepoPathPickItems(items)) {
          const repoPick = vi.mocked(window.showQuickPick).mock.calls.length === 1 ? '/invalid/repo' : '/valid/repo';
          return items.find(item => item.pickKind === 'repo' && item.repoPath === repoPick);
        }
        if (isWorkModePickItems(items)) {
          return { label: 'Create worktree', value: 'worktree' } as any;
        }
        return undefined;
      });

      await action.run(item);

      expect(window.showErrorMessage).not.toHaveBeenCalled();
      expect(window.showQuickPick).toHaveBeenCalledTimes(3);
      expect(memento.update).toHaveBeenCalledWith('repoPath:acme/repo', '/valid/repo');
    });

    it('uses headCloneUrl when a PR supplies one', async () => {
      mockNoLocalBranch();
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr',
        cloneUrl: 'https://example.com/acme/repo.git',
        headCloneUrl: 'https://example.com/contributor/repo.git',
        ref: 'feature/topic',
        repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['remote', '-v'],
        ['remote', 'add', 'devdocket-fork-contributor', 'https://example.com/contributor/repo.git'],
        ['fetch', 'devdocket-fork-contributor', '+refs/heads/feature/topic:refs/remotes/devdocket-fork-contributor/feature/topic'],
        ['rev-parse', '--verify', 'refs/heads/feature/topic'],
        ['worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'repo-pr-1'), 'devdocket-fork-contributor/feature/topic'],
      ]);
    });

    it('falls back to cloneUrl when a PR has no headCloneUrl', async () => {
      mockNoLocalBranch();
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['remote', '-v'],
        ['fetch', 'origin', '+refs/heads/feature/topic:refs/remotes/origin/feature/topic'],
        ['rev-parse', '--verify', 'refs/heads/feature/topic'],
        ['worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'repo-pr-1'), 'origin/feature/topic'],
      ]);
    });

    it('prompts for PR branch name and worktree path when promptForNames is enabled', async () => {
      mockNoLocalBranch();
      const customWorktreePath = path.join('/mock', 'custom-pr-worktree');
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.title === 'DevDocket: Branch name') {
          return 'custom-pr-branch';
        }
        if (options?.title === 'DevDocket: Worktree path') {
          return customWorktreePath;
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toEqual(expect.objectContaining({
        value: 'feature/topic',
      }));
      expect(inputBoxOptions('DevDocket: Worktree path')).toEqual(expect.objectContaining({
        value: path.join('/mock', 'repo-pr-1'),
      }));
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'fetch', 'origin', '+refs/heads/feature/topic:refs/remotes/origin/feature/topic',
      ]);
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'worktree', 'add', '-b', 'custom-pr-branch', customWorktreePath, 'origin/feature/topic',
      ]);
    });

    it('uses PR worktree path silently when promptForNames is disabled', async () => {
      setPromptForNames(false);
      mockNoLocalBranch();
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toBeUndefined();
      expect(inputBoxOptions('DevDocket: Worktree path')).toBeUndefined();
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'repo-pr-1'), 'origin/feature/topic',
      ]);
    });

    it('aborts without side effects when the PR branch-name prompt is cancelled', async () => {
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.title === 'DevDocket: Branch name') {
          return undefined;
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(execFile).not.toHaveBeenCalled();
      expect(window.withProgress).not.toHaveBeenCalled();
    });

    it('defaults PR worktree paths to source repo and PR number', async () => {
      mockNoLocalBranch();
      (workspace as any).workspaceFolders = [{ uri: { fsPath: '/mock/sdk' } }];
      mockQuickPicks('/mock/sdk');
      const item = createWorkItem({ externalId: 'dotnet/install-scripts#692' });
      const { action } = createAction(discovered('provider', 'dotnet/install-scripts#692', {
        kind: 'pr', cloneUrl: 'https://github.com/dotnet/install-scripts.git', ref: 'fix-incorrect-corrupted-size-message', repoLabel: 'dotnet/install-scripts',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Worktree path')).toEqual(expect.objectContaining({
        value: path.join('/mock', 'install-scripts-pr-692'),
      }));
    });

    it('defaults ADO PR worktree paths from bang-delimited external ids', async () => {
      mockNoLocalBranch();
      const item = createWorkItem({ externalId: 'org/project/repo!42' });
      const { action } = createAction(discovered('provider', 'org/project/repo!42', {
        kind: 'pr', cloneUrl: 'https://dev.azure.com/org/project/_git/repo', ref: 'feature/topic', repoLabel: 'org/project/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Worktree path')).toEqual(expect.objectContaining({
        value: path.join('/mock', 'repo-pr-42'),
      }));
    });

    it('falls back to the local repo, ref slug, and stable identity when no work item number is derivable', async () => {
      mockNoLocalBranch();
      const item = createWorkItem({ externalId: 'work-item' });
      const { action } = createAction(discovered('provider', 'work-item', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: undefined,
      }));

      await action.run(item);

      const defaultPath = inputBoxOptions('DevDocket: Worktree path')?.value;
      expect(path.basename(defaultPath)).toMatch(/^workspace-feature-topic-[a-z0-9]{6}$/);
    });

    it('keeps fallback worktree paths distinct for different work items with the same ref', async () => {
      setPromptForNames(false);
      mockNoLocalBranch();
      const gitWork = {
        kind: 'pr' as const,
        cloneUrl: 'https://example.com/acme/repo.git',
        ref: 'feature/topic',
        repoLabel: undefined,
      };
      const { action } = createAction({
        ...discovered('provider', 'work-a', gitWork),
        ...discovered('provider', 'work-b', gitWork),
      });

      await action.run(createWorkItem({ id: 'wc-test-a', externalId: 'work-a' }));
      await action.run(createWorkItem({ id: 'wc-test-b', externalId: 'work-b' }));

      const worktreePaths = vi.mocked(execFile).mock.calls
        .map(call => call[1])
        .filter(args => args[0] === 'worktree' && args[1] === 'add')
        .map(args => args[4]);
      expect(worktreePaths).toHaveLength(2);
      expect(path.basename(worktreePaths[0])).toMatch(/^workspace-feature-topic-[a-z0-9]{6}$/);
      expect(path.basename(worktreePaths[1])).toMatch(/^workspace-feature-topic-[a-z0-9]{6}$/);
      expect(worktreePaths[0]).not.toEqual(worktreePaths[1]);
    });

    it('prompts for issue checkout branch name but skips worktree path', async () => {
      mockQuickPicks('/mock/workspace', 'checkout');
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.prompt?.includes('base branch')) {
          return 'origin/dev';
        }
        if (options?.title === 'DevDocket: Branch name') {
          return 'refs/heads/custom-checkout';
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toBeDefined();
      expect(inputBoxOptions('DevDocket: Worktree path')).toBeUndefined();
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual(['checkout', '-b', 'custom-checkout', 'origin/dev']);
    });

    it('prompts for PR checkout branch name but skips worktree path', async () => {
      mockQuickPicks('/mock/workspace', 'checkout');
      mockNoLocalBranch();
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.title === 'DevDocket: Branch name') {
          return 'refs/heads/custom-pr-checkout';
        }
        return options?.value;
      });
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toBeDefined();
      expect(inputBoxOptions('DevDocket: Worktree path')).toBeUndefined();
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'fetch', 'origin', '+refs/heads/feature/topic:refs/remotes/origin/feature/topic',
      ]);
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual(['checkout', '-b', 'custom-pr-checkout', '--track', 'origin/feature/topic']);
    });

    it('normalizes fully-qualified PR head refs before fetching and checking out', async () => {
      mockNoLocalBranch();
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'refs/heads/feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['remote', '-v'],
        ['fetch', 'origin', '+refs/heads/feature/topic:refs/remotes/origin/feature/topic'],
        ['rev-parse', '--verify', 'refs/heads/feature/topic'],
        ['worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'repo-pr-1'), 'origin/feature/topic'],
      ]);
    });

    it('uses repoLabel for ADO _git remote names', async () => {
      mockNoLocalBranch('origin\thttps://example.com/other/repo.git (fetch)\n');
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr',
        cloneUrl: 'https://dev.azure.com/myorg/MyProject/_git/myrepo',
        ref: 'feature/topic',
        repoLabel: 'myorg/MyProject/myrepo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'remote', 'add', 'devdocket-fork-myorg-MyProject-myrepo', 'https://dev.azure.com/myorg/MyProject/_git/myrepo',
      ]);
    });

    it('reports fetch failures with git error details', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          cb(null, ORIGIN_REMOTE_V, '');
          return;
        }
        if (args[0] === 'fetch') {
          cb(new Error('fetch failed'), '', 'Authentication failed');
          return;
        }
        cb(null, '', '');
      }) as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        "DevDocket: Could not fetch branch 'feature/topic' from remote 'origin'. Authentication failed",
      );
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).not.toContainEqual([
        'worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'repo-pr-1'), 'origin/feature/topic',
      ]);
    });

    it('rejects an invalid cloneUrl returned by a lazy resolver', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'not a url', ref: 'issue123', repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an invalid clone URL for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects git SSH clone URLs with unsafe hosts', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'git@-evil.example:acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an invalid clone URL for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects HTTPS clone URLs with embedded credentials or token-bearing suffixes', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'https://user:token@example.com/acme/repo.git?token=secret', ref: 'issue123', repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an invalid clone URL for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('accepts Azure DevOps HTTPS clone URLs that include a username', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'pr', cloneUrl: 'https://myorg@dev.azure.com/myorg/MyProject/_git/myrepo', ref: 'users/me/fix', repoLabel: 'MyProject/myrepo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).not.toHaveBeenCalledWith('DevDocket: Provider returned an invalid clone URL for this work item.');
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['remote', '-v'],
        ['remote', 'add', 'devdocket-fork-MyProject-myrepo', 'https://myorg@dev.azure.com/myorg/MyProject/_git/myrepo'],
        ['fetch', 'devdocket-fork-MyProject-myrepo', '+refs/heads/users/me/fix:refs/remotes/devdocket-fork-MyProject-myrepo/users/me/fix'],
        ['rev-parse', '--verify', 'refs/heads/users/me/fix'],
        ['worktree', 'add', '--detach', path.join('/mock', 'myrepo-pr-1'), 'devdocket-fork-MyProject-myrepo/users/me/fix'],
      ]);
    });

    it('rejects an invalid ref returned by a lazy resolver', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: '-bad', repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an invalid git ref for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it.each(['foo..bar', 'foo.', 'foo/', 'foo//bar'])('rejects git-invalid ref %s', async (ref) => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref, repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an invalid git ref for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects non-string provider refs without throwing', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 123 as any, repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an invalid git ref for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects unsupported fully-qualified PR refs', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'refs/pull/123/head', repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an unsupported git branch ref for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('normalizes fully-qualified issue head refs before creating a branch', async () => {
      const item = createWorkItem({ providerId: 'fake-vendor', externalId: 'ABC-123' });
      const { action } = createAction(discovered('fake-vendor', 'ABC-123', {
        kind: 'issue', cloneUrl: 'https://git.example.com/acme/repo.git', ref: 'refs/heads/vendor/ABC-123', repoLabel: 'Vendor Repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(['branch', '--list', 'vendor/ABC-123']);
      expect(vi.mocked(execFile).mock.calls[1][1]).toEqual(['branch', 'vendor/ABC-123', 'origin/dev']);
      expect(vi.mocked(execFile).mock.calls[2][1]).toEqual([
        'worktree', 'add', path.join('/mock', 'Vendor-Repo-issue-123'), 'vendor/ABC-123',
      ]);
    });

    it('rejects unsupported fully-qualified issue refs', async () => {
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', async () => ({
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'refs/tags/v1', repoLabel: 'acme/repo',
      })));

      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith('DevDocket: Provider returned an unsupported git branch ref for this work item.');
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    it('aborts checkout when the working tree is dirty and the user cancels', async () => {
      mockQuickPicks('/mock/workspace', 'checkout');
      vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as any);
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'status') {
          cb(null, ' M file.ts\n', '');
          return;
        }
        cb(null, '', '');
      }) as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'Working tree has uncommitted changes. Checkout anyway?',
        { modal: true },
        'Yes',
      );
      expect(inputBoxOptions('DevDocket: Branch name')).toBeDefined();
      const branchPromptOrder = inputBoxInvocationOrder('DevDocket: Branch name');
      const dirtyPromptOrder = vi.mocked(window.showWarningMessage).mock.invocationCallOrder[0];
      expect(branchPromptOrder).toBeDefined();
      expect(branchPromptOrder!).toBeLessThan(dirtyPromptOrder);
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).not.toContainEqual(['checkout', '-b', 'issue123', 'origin/dev']);
    });

    it('prompts for the issue checkout branch before proceeding through a dirty working tree', async () => {
      mockQuickPicks('/mock/workspace', 'checkout');
      vi.mocked(window.showWarningMessage).mockResolvedValue('Yes' as any);
      vi.mocked(window.showInputBox).mockImplementation(async (options: any) => {
        if (options?.prompt?.includes('base branch')) {
          return 'origin/dev';
        }
        if (options?.title === 'DevDocket: Branch name') {
          return 'custom-dirty-checkout';
        }
        return options?.value;
      });
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'status') {
          cb(null, ' M file.ts\n', '');
          return;
        }
        cb(null, '', '');
      }) as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(inputBoxOptions('DevDocket: Branch name')).toBeDefined();
      const branchPromptOrder = inputBoxInvocationOrder('DevDocket: Branch name');
      const dirtyPromptOrder = vi.mocked(window.showWarningMessage).mock.invocationCallOrder[0];
      expect(branchPromptOrder).toBeDefined();
      expect(branchPromptOrder!).toBeLessThan(dirtyPromptOrder);
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual(['checkout', '-b', 'custom-dirty-checkout', 'origin/dev']);
    });

    it('checks out an existing same-repo PR branch directly', async () => {
      mockQuickPicks('/mock/workspace', 'checkout');
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          cb(null, ORIGIN_REMOTE_V, '');
          return;
        }
        cb(null, '', '');
      }) as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
        ['remote', '-v'],
        ['fetch', 'origin', '+refs/heads/feature/topic:refs/remotes/origin/feature/topic'],
        ['status', '--porcelain'],
        ['rev-parse', '--verify', 'refs/heads/feature/topic'],
        ['worktree', 'list', '--porcelain'],
        ['checkout', 'feature/topic'],
      ]);
    });

    it('creates a detached PR worktree when a fork PR branch already exists locally', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          cb(null, ORIGIN_REMOTE_V, '');
          return;
        }
        cb(null, '', '');
      }) as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr',
        cloneUrl: 'https://example.com/acme/repo.git',
        headCloneUrl: 'https://example.com/contributor/repo.git',
        ref: 'feature/topic',
        repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'worktree', 'add', '--detach', path.join('/mock', 'repo-pr-1'), 'devdocket-fork-contributor/feature/topic',
      ]);
    });

    it('updates an existing DevDocket-managed remote with a stale URL', async () => {
      mockNoLocalBranch('devdocket-fork-contributor\thttps://example.com/old/repo.git (fetch)\n');
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          cb(null, 'devdocket-fork-contributor\thttps://example.com/old/repo.git (fetch)\n', '');
          return;
        }
        if (args[0] === 'remote' && args[1] === 'add') {
          cb(new Error('remote already exists'), '', '');
          return;
        }
        if (args[0] === 'remote' && args[1] === 'get-url') {
          cb(null, 'https://example.com/old/repo.git\n', '');
          return;
        }
        if (args[0] === 'rev-parse') {
          cb(new Error('not a valid ref'), '', '');
          return;
        }
        cb(null, '', '');
      }) as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'pr',
        cloneUrl: 'https://example.com/acme/repo.git',
        headCloneUrl: 'https://example.com/contributor/repo.git',
        ref: 'feature/topic',
        repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
        'remote', 'set-url', 'devdocket-fork-contributor', 'https://example.com/contributor/repo.git',
      ]);
    });

    it('runs configured post-worktree commands with the created worktree path', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => key === 'commands'
          ? [{ command: 'npm', args: ['install', '--prefix', '{path}'] }]
          : defaultValue),
      } as any);
      const item = createWorkItem();
      const { action } = createAction(discovered('provider', 'item-1', {
        kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', ref: 'issue123', repoLabel: 'acme/repo',
      }));

      await action.run(item);

      expect(vi.mocked(execFile).mock.calls.map(call => [call[0], call[1], call[2]])).toContainEqual([
        'npm', ['install', '--prefix', path.join('/mock', 'repo-issue-1')], { cwd: path.join('/mock', 'repo-issue-1'), timeout: 60_000 },
      ]);
    });

    it('accepts and routes a third-party provider without host or provider-id knowledge', async () => {
      const item = createWorkItem({ providerId: 'fake-vendor', externalId: 'work-42' });
      const { action } = createAction(discovered('fake-vendor', 'work-42', {
        kind: 'issue', cloneUrl: 'git@git.fake-vendor.example:team/repo.git', ref: 'fake/work-42', repoLabel: 'Fake Vendor Repo',
      }));

      expect(action.canRun(item)).toBe(true);
      await action.run(item);

      expect(vi.mocked(execFile).mock.calls[1][1]).toEqual(['branch', 'fake/work-42', 'origin/dev']);
    });

    describe('worktree branch-conflict detection (porcelain pre-check)', () => {
      it('creates detached worktree when same-repo PR branch is held by another worktree', async () => {
        // Default mock leaves rev-parse --verify succeeding → hasLocalBranch=true.
        // Same-repo PR (no headCloneUrl) → trackingRef=undefined →
        // worktreeSourceRef = 'origin/feature/topic'.
        vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
          if (args[0] === 'remote' && args[1] === '-v') {
            cb(null, ORIGIN_REMOTE_V, '');
            return;
          }
          if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
            cb(null,
              'worktree /mock/workspace\n' +
              'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
              'branch refs/heads/main\n' +
              '\n' +
              'worktree /mock/other-worktree\n' +
              'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' +
              'branch refs/heads/feature/topic\n' +
              '\n', '');
            return;
          }
          cb(null, '', '');
        }) as any);
        const item = createWorkItem();
        const { action } = createAction(discovered('provider', 'item-1', {
          kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
        }));

        await action.run(item);

        const worktreeAddCalls = vi.mocked(execFile).mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'worktree' && call[1]?.[1] === 'add',
        );
        // Only one attempt — straight to the detached path.
        expect(worktreeAddCalls).toHaveLength(1);
        expect(worktreeAddCalls[0]![1]).toEqual([
          'worktree', 'add', '--detach',
          path.join('/mock', 'repo-pr-1'),
          'origin/feature/topic',
        ]);
        expect(window.showErrorMessage).not.toHaveBeenCalled();
      });

      it('uses non-detached worktree add when no other worktree holds the branch', async () => {
        // Sanity: porcelain returns empty output → no conflict → use local branch directly.
        vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
          if (args[0] === 'remote' && args[1] === '-v') {
            cb(null, ORIGIN_REMOTE_V, '');
            return;
          }
          cb(null, '', '');
        }) as any);
        const item = createWorkItem();
        const { action } = createAction(discovered('provider', 'item-1', {
          kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
        }));

        await action.run(item);

        const worktreeAddCalls = vi.mocked(execFile).mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'worktree' && call[1]?.[1] === 'add',
        );
        expect(worktreeAddCalls).toHaveLength(1);
        expect(worktreeAddCalls[0]![1]).toEqual([
          'worktree', 'add',
          path.join('/mock', 'repo-pr-1'),
          'feature/topic',
        ]);
      });

      it('ignores worktrees holding a branch with a similar name (substring guard)', async () => {
        // refs/heads/feature/topic-extra must NOT match refs/heads/feature/topic.
        vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
          if (args[0] === 'remote' && args[1] === '-v') {
            cb(null, ORIGIN_REMOTE_V, '');
            return;
          }
          if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
            cb(null,
              'worktree /mock/other\n' +
              'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' +
              'branch refs/heads/feature/topic-extra\n' +
              '\n', '');
            return;
          }
          cb(null, '', '');
        }) as any);
        const item = createWorkItem();
        const { action } = createAction(discovered('provider', 'item-1', {
          kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
        }));

        await action.run(item);

        const worktreeAddCalls = vi.mocked(execFile).mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'worktree' && call[1]?.[1] === 'add',
        );
        expect(worktreeAddCalls).toHaveLength(1);
        expect(worktreeAddCalls[0]![1]).toEqual([
          'worktree', 'add',
          path.join('/mock', 'repo-pr-1'),
          'feature/topic',
        ]);
      });

      it('falls through to non-detached worktree add when porcelain command itself fails', async () => {
        // Pre-check is best-effort — if porcelain itself errors, fall through to
        // the normal worktree add and let any real conflict surface from git.
        vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
          if (args[0] === 'remote' && args[1] === '-v') {
            cb(null, ORIGIN_REMOTE_V, '');
            return;
          }
          if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
            const err = new Error('fatal: not a git repository');
            (err as any).stderr = 'fatal: not a git repository';
            cb(err, '', (err as any).stderr);
            return;
          }
          cb(null, '', '');
        }) as any);
        const item = createWorkItem();
        const { action } = createAction(discovered('provider', 'item-1', {
          kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
        }));

        await action.run(item);

        const worktreeAddCalls = vi.mocked(execFile).mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'worktree' && call[1]?.[1] === 'add',
        );
        expect(worktreeAddCalls).toHaveLength(1);
        expect(worktreeAddCalls[0]![1]).toEqual([
          'worktree', 'add',
          path.join('/mock', 'repo-pr-1'),
          'feature/topic',
        ]);
      });

      it('shows error in checkout mode when same-repo PR branch is held by another worktree', async () => {
        mockQuickPicks('/mock/workspace', 'checkout');
        vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
          if (args[0] === 'remote' && args[1] === '-v') {
            cb(null, ORIGIN_REMOTE_V, '');
            return;
          }
          if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
            cb(null,
              'worktree /mock/workspace\n' +
              'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
              'branch refs/heads/main\n' +
              '\n' +
              'worktree /mock/other-worktree\n' +
              'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' +
              'branch refs/heads/feature/topic\n' +
              '\n', '');
            return;
          }
          cb(null, '', '');
        }) as any);
        const item = createWorkItem();
        const { action } = createAction(discovered('provider', 'item-1', {
          kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
        }));

        await action.run(item);

        // No checkout was attempted — short-circuited with a clear error.
        const checkoutCall = vi.mocked(execFile).mock.calls.find(
          (call: any[]) => call[1]?.[0] === 'checkout',
        );
        expect(checkoutCall).toBeUndefined();
        expect(window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('/mock/other-worktree'),
        );
        expect(window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('feature/topic'),
        );
      });

      it('proceeds with checkout when the current repo worktree itself holds the branch', async () => {
        // If the user is already on the PR branch in the current worktree,
        // `git checkout <branch>` is a no-op success — the pre-check must NOT
        // block by treating the current worktree as a conflict.
        mockQuickPicks('/mock/workspace', 'checkout');
        vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
          if (args[0] === 'remote' && args[1] === '-v') {
            cb(null, ORIGIN_REMOTE_V, '');
            return;
          }
          if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
            cb(null,
              'worktree /mock/workspace\n' +
              'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
              'branch refs/heads/feature/topic\n' +
              '\n', '');
            return;
          }
          cb(null, '', '');
        }) as any);
        const item = createWorkItem();
        const { action } = createAction(discovered('provider', 'item-1', {
          kind: 'pr', cloneUrl: 'https://example.com/acme/repo.git', ref: 'feature/topic', repoLabel: 'acme/repo',
        }));

        await action.run(item);

        expect(window.showErrorMessage).not.toHaveBeenCalled();
        const checkoutCall = vi.mocked(execFile).mock.calls.find(
          (call: any[]) => call[1]?.[0] === 'checkout',
        );
        expect(checkoutCall).toBeDefined();
        expect(checkoutCall![1]).toEqual(['checkout', 'feature/topic']);
      });
    });
  });
});

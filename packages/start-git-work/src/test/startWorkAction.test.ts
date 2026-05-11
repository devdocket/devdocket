import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace } from 'vscode';
import { StartWorkAction } from '../startWorkAction';
import * as path from 'path';
import type { DiscoveredItemCapabilities } from '@devdocket/shared';

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

type GitWork = NonNullable<DiscoveredItemCapabilities['gitWork']>;

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
    return undefined;
  });
}

function mockQuickPickWorktree() {
  vi.mocked(window.showQuickPick).mockResolvedValue({ label: 'Create worktree', value: 'worktree' } as any);
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
    mockInputBox('/mock/workspace');
    mockQuickPickWorktree();
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
        'worktree', 'add', path.join('/mock', 'workspace-vendor-ABC-123'), 'vendor/ABC-123',
      ]);
      expect(memento.update).toHaveBeenCalledWith('repoPath:Vendor Repo', '/mock/workspace');
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
        ['worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'workspace-feature-topic'), 'devdocket-fork-contributor/feature/topic'],
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
        ['worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'workspace-feature-topic'), 'origin/feature/topic'],
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
        'worktree', 'add', '-b', 'feature/topic', path.join('/mock', 'workspace-feature-topic'), 'origin/feature/topic',
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

    it('aborts checkout when the working tree is dirty and the user cancels', async () => {
      vi.mocked(window.showQuickPick).mockResolvedValue({ label: 'Checkout branch', value: 'checkout' } as any);
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
      expect(vi.mocked(execFile).mock.calls.map(call => call[1])).not.toContainEqual(['checkout', '-b', 'issue123', 'origin/dev']);
    });

    it('checks out an existing same-repo PR branch directly', async () => {
      vi.mocked(window.showQuickPick).mockResolvedValue({ label: 'Checkout branch', value: 'checkout' } as any);
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
        'worktree', 'add', '--detach', path.join('/mock', 'workspace-feature-topic'), 'devdocket-fork-contributor/feature/topic',
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
        'npm', ['install', '--prefix', path.join('/mock', 'workspace-issue123')], { cwd: path.join('/mock', 'workspace-issue123'), timeout: 60_000 },
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
  });
});

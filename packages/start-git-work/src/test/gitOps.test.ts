import { describe, it, expect, beforeEach, vi } from 'vitest';

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

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { execFile } from 'child_process';
import {
  fetchPrBranch,
  findOrAddRemote,
  findWorktreeHoldingBranch,
  GitFetchBranchError,
  isValidCloneUrl,
  isValidRef,
  normalizeBranchName,
  normalizeCloneUrl,
  rollbackCreatedBranch,
  toRemoteName,
} from '../gitOps';

const ORIGIN_REMOTE_V = 'origin\thttps://example.com/acme/repo.git (fetch)\norigin\thttps://example.com/acme/repo.git (push)\n';

describe('gitOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => cb(null, '', '')) as any);
  });

  it('validates and normalizes refs the same way Start Git Work expects', () => {
    expect(normalizeBranchName('refs/heads/feature/topic')).toBe('feature/topic');
    expect(isValidRef('feature/topic')).toBe(true);
    expect(isValidRef('-bad')).toBe(false);
    expect(isValidRef('bad branch')).toBe(false);
    expect(isValidRef('bad..branch')).toBe(false);
    expect(isValidRef('refs/tags/v1')).toBe(true);
  });

  it('validates clone URLs and strips Azure DevOps usernames', () => {
    expect(isValidCloneUrl('https://github.com/owner/repo.git')).toBe(true);
    expect(isValidCloneUrl('git@github.com:owner/repo.git')).toBe(true);
    expect(isValidCloneUrl('https://token@github.com/owner/repo.git')).toBe(false);
    expect(isValidCloneUrl('https://user:token@example.com/owner/repo.git?token=secret')).toBe(false);
    expect(isValidCloneUrl('https://myorg@dev.azure.com/myorg/project/_git/repo')).toBe(true);
    expect(normalizeCloneUrl('https://myorg@dev.azure.com/myorg/project/_git/repo')).toBe('https://dev.azure.com/myorg/project/_git/repo');
  });

  it('finds an existing matching remote before adding a DevDocket remote', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      if (args[0] === 'remote' && args[1] === '-v') {
        cb(null, ORIGIN_REMOTE_V, '');
        return;
      }
      cb(null, '', '');
    }) as any);

    await expect(findOrAddRemote('https://example.com/acme/repo.git', 'acme/repo', '/repo')).resolves.toBe('origin');
    expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
      ['remote', '-v'],
    ]);
  });

  it('adds or updates a DevDocket-managed remote when no matching remote exists', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      if (args[0] === 'remote' && args[1] === '-v') {
        cb(null, 'devdocket-fork-contributor\thttps://example.com/old/repo.git (fetch)\n', '');
        return;
      }
      if (args[0] === 'remote' && args[1] === 'add') {
        cb(new Error('remote exists'), '', '');
        return;
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        cb(null, 'https://example.com/old/repo.git\n', '');
        return;
      }
      cb(null, '', '');
    }) as any);

    await expect(findOrAddRemote('https://example.com/contributor/repo.git', 'acme/repo', '/repo')).resolves.toBe('devdocket-fork-contributor');
    expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual([
      'remote', 'set-url', 'devdocket-fork-contributor', 'https://example.com/contributor/repo.git',
    ]);
  });

  it('fetches provider PR branches and reports non-origin tracking refs', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      if (args[0] === 'remote' && args[1] === '-v') {
        cb(null, '', '');
        return;
      }
      cb(null, '', '');
    }) as any);

    await expect(fetchPrBranch({
      cloneUrl: 'https://example.com/acme/repo.git',
      headCloneUrl: 'https://example.com/contributor/repo.git',
      ref: 'refs/heads/feature/topic',
      repoLabel: 'acme/repo',
    }, '/repo')).resolves.toEqual({
      branchName: 'feature/topic',
      sourceRef: 'devdocket-fork-contributor/feature/topic',
      trackingRef: 'devdocket-fork-contributor/feature/topic',
    });
  });

  it('propagates AbortError from fetch without wrapping it', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      if (args[0] === 'remote' && args[1] === '-v') {
        cb(null, ORIGIN_REMOTE_V, '');
        return;
      }
      if (args[0] === 'fetch') {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        cb(err, '', '');
        return;
      }
      cb(null, '', '');
    }) as any);

    await expect(fetchPrBranch({
      cloneUrl: 'https://example.com/acme/repo.git',
      ref: 'feature/topic',
      repoLabel: 'acme/repo',
    }, '/repo')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('wraps non-abort fetch failures with remote and branch context', async () => {
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

    await expect(fetchPrBranch({
      cloneUrl: 'https://example.com/acme/repo.git',
      ref: 'feature/topic',
      repoLabel: 'acme/repo',
    }, '/repo')).rejects.toMatchObject<Partial<GitFetchBranchError>>({
      upstreamBranchName: 'feature/topic',
      remoteName: 'origin',
      details: 'Authentication failed',
    });
  });

  it('parses worktree porcelain output and honors the excluded current worktree', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      cb(null,
        'worktree /repo\n' +
        'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
        'branch refs/heads/feature/topic\n' +
        '\n' +
        'worktree /other\n' +
        'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' +
        'branch refs/heads/feature/topic\n' +
        '\n', '');
    }) as any);

    await expect(findWorktreeHoldingBranch('feature/topic', '/repo', '/repo')).resolves.toBe('/other');
  });

  it('rolls back with force delete only when the branch still points at the base branch tip', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      if (args[0] === 'branch' && args[1] === '-d') {
        cb(new Error('not fully merged'), '', 'error: the branch is not fully merged');
        return;
      }
      if (args[0] === 'rev-parse' && args[3] === 'refs/heads/issue123') {
        cb(null, 'abc123\n', '');
        return;
      }
      if (args[0] === 'rev-parse' && args[3] === 'origin/dev') {
        cb(null, 'abc123\n', '');
        return;
      }
      cb(null, '', '');
    }) as any);

    await rollbackCreatedBranch('issue123', 'origin/dev', '/repo');

    expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual(['branch', '-D', '--', 'issue123']);
  });

  it('derives safe DevDocket remote names from clone URLs and labels', () => {
    expect(toRemoteName('https://github.com/owner/repo.git', 'ignored')).toBe('devdocket-fork-owner');
    expect(toRemoteName('https://dev.azure.com/org/project/_git/repo', 'org/project/repo')).toBe('devdocket-fork-org-project-repo');
  });
});

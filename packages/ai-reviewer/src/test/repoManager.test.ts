import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authentication, workspace, mockLogOutputChannel } from 'vscode';
import { RepoManager, parsePrUrl, __testing } from '../repoManager';
import { GitExecError } from '../tools/gitUtils';
const { resetGitVersionCheck } = __testing;

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    // Return valid version for `git --no-pager version` calls
    if (args?.includes('version')) {
      cb(null, 'git version 2.45.0.windows.1', '');
    } else {
      cb(null, '', '');
    }
  }),
}));

import { execFile } from 'child_process';

const originalProcessPlatform = process.platform;

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function createRepoManager(): RepoManager {
  return new RepoManager({ fsPath: '/mock/storage' } as never, mockLogOutputChannel as never);
}

function getCloneArgs(): string[] {
  const cloneCall = vi.mocked(execFile).mock.calls.find(c => c[1]?.includes('clone'));
  expect(cloneCall).toBeDefined();
  return cloneCall![1] as string[];
}

function getLongpathsConfigCalls() {
  return vi.mocked(execFile).mock.calls.filter(c => {
    const args = c[1] as string[] | undefined;
    return args?.includes('config')
      && args.includes('--local')
      && args.includes('core.longpaths')
      && args.includes('true');
  });
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function mockExistingDirectories(paths: string[]): void {
  const existingPaths = new Set(paths.map(normalizePath));
  vi.mocked(workspace.fs.stat).mockImplementation(async uri => {
    const fsPath = normalizePath((uri as { fsPath: string }).fsPath);
    if (existingPaths.has(fsPath)) {
      return { type: 2 } as never;
    }
    throw new Error('not found');
  });
}

function mockGitDirectoryValidationFailure(
  invalidPath: string,
  stderr = 'fatal: not a git repository',
  code = 128,
): void {
  vi.mocked(execFile).mockImplementation(
    (_cmd: string, args: string[], opts: unknown, cb: Function) => {
      const cwd = normalizePath((opts as { cwd?: string } | undefined)?.cwd ?? '');
      if (args?.includes('version')) {
        cb(null, 'git version 2.45.0.windows.1', '');
      } else if (
        args?.includes('rev-parse')
        && args.includes('--resolve-git-dir')
        && args.some(arg => normalizePath(arg) === `${normalizePath(invalidPath)}/.git`)
        && cwd === normalizePath(invalidPath)
      ) {
        cb(Object.assign(new Error('git failed'), { code }), '', stderr);
      } else {
        cb(null, '', '');
      }
    },
  );
}

function mockAdoPrDetails(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      sourceRefName: 'refs/heads/feature/add-api',
      targetRefName: 'refs/heads/main',
      repository: {
        remoteUrl: 'https://dev.azure.com/org/project/_git/repo',
      },
    }),
  }));
}

function failGitCommand(match: (args: string[]) => boolean, stderr: string): void {
  vi.mocked(execFile).mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args?.includes('version')) {
        cb(null, 'git version 2.45.0.windows.1', '');
      } else if (match(args)) {
        cb(Object.assign(new Error('git failed'), { code: 1 }), '', stderr);
      } else {
        cb(null, '', '');
      }
    },
  );
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return normalizePath(err instanceof Error ? err.message : String(err));
  }
  throw new Error('Expected promise to reject');
}

describe('parsePrUrl', () => {
  it('parses a valid GitHub PR URL', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42');
    expect(result).toEqual({ org: 'owner', repo: 'repo', prNumber: '42' });
  });

  it('parses a PR URL with query string', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42?diff=unified');
    expect(result).toEqual({ org: 'owner', repo: 'repo', prNumber: '42' });
  });

  it('parses a PR URL with fragment', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42#discussion_r123');
    expect(result).toEqual({ org: 'owner', repo: 'repo', prNumber: '42' });
  });

  it('parses a PR URL with trailing GitHub view segments', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42/files');
    expect(result).toEqual({ org: 'owner', repo: 'repo', prNumber: '42' });
  });

  it('returns undefined for non-PR URLs', () => {
    expect(parsePrUrl('https://github.com/owner/repo/issues/42')).toBeUndefined();
  });

  it('returns undefined for invalid URLs', () => {
    expect(parsePrUrl('not-a-url')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parsePrUrl('')).toBeUndefined();
  });
});

describe('RepoManager', () => {
  let manager: RepoManager;

  afterEach(() => {
    vi.unstubAllGlobals();
    setProcessPlatform(originalProcessPlatform);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGitVersionCheck();

    // Restore default execFile mock (returns version for `git version`, empty otherwise)
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if ((args as string[])?.includes('version')) {
          cb(null, 'git version 2.45.0.windows.1', '');
        } else {
          cb(null, '', '');
        }
      },
    );

    manager = createRepoManager();

    // Default auth mock
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'mock-token' } as never);

    // Default workspace.fs.stat mock — directory does not exist
    vi.mocked(workspace.fs.stat).mockRejectedValue(new Error('not found'));
    vi.mocked(workspace.fs.createDirectory).mockResolvedValue(undefined as never);
    vi.mocked(workspace.fs.delete).mockResolvedValue(undefined as never);

    // Mock fetch for PR metadata
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        base: { ref: 'main' },
        head: { sha: 'abc123' },
      }),
    }));
  });

  describe('ensureWorktree', () => {
    it('throws for invalid PR URLs', async () => {
      await expect(manager.ensureWorktree('not-a-url')).rejects.toThrow('Invalid PR URL');
    });

    it('does not include query strings or fragments in invalid URL errors', async () => {
      await expect(manager.ensureWorktree('https://example.com/not-pr?token=secret#frag')).rejects.toThrow(
        'Invalid PR URL: https://example.com/not-pr',
      );
    });

    it('redacts query strings and fragments from parse-failing URLs', async () => {
      await expect(manager.ensureWorktree('https://exa mple.com/not-pr?token=secret#frag')).rejects.toThrow(
        'Invalid PR URL: (URL unavailable)',
      );
    });

    it('redacts userinfo from parse-failing URLs', async () => {
      await expect(manager.ensureWorktree('https://user:password@exa mple.com/not-pr?token=secret')).rejects.toThrow(
        'Invalid PR URL: (URL unavailable)',
      );
    });

    it('does not log query strings or fragments from PR URLs', async () => {
      await manager.ensureWorktree('https://github.com/owner/repo/pull/42?token=secret#frag');

      const debugMessages = vi.mocked(mockLogOutputChannel.debug).mock.calls.map(call => String(call[0]));
      expect(debugMessages).toContain('ensureWorktree called — prUrl: https://github.com/owner/repo/pull/42');
      expect(debugMessages.join('\n')).not.toContain('secret');
      expect(debugMessages.join('\n')).not.toContain('frag');
    });

    it('calls git clone for a fresh repo', async () => {
      const item = 'https://github.com/owner/repo/pull/42';
      await manager.ensureWorktree(item);

      const cloneArgs = getCloneArgs();
      expect(cloneArgs).toContain('--no-checkout');
    });

    it('passes core.longpaths config to fresh GitHub clones on Windows', async () => {
      setProcessPlatform('win32');

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const args = getCloneArgs();
      const configIndex = args.indexOf('-c');
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(args[configIndex + 1]).toBe('core.longpaths=true');
      expect(configIndex).toBeLessThan(args.indexOf('clone'));
    });

    it('does not pass core.longpaths config to fresh GitHub clones on non-Windows', async () => {
      setProcessPlatform('linux');

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      expect(getCloneArgs()).not.toContain('core.longpaths=true');
    });

    it('passes core.longpaths config to fresh ADO clones on Windows', async () => {
      setProcessPlatform('win32');
      mockAdoPrDetails();

      await manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42');

      const args = getCloneArgs();
      const configIndex = args.indexOf('-c');
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(args[configIndex + 1]).toBe('core.longpaths=true');
      expect(configIndex).toBeLessThan(args.indexOf('clone'));
    });

    it('persists core.longpaths to a fresh GitHub clone local config on Windows', async () => {
      setProcessPlatform('win32');

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const configCalls = getLongpathsConfigCalls();
      expect(configCalls).toHaveLength(1);
      expect(normalizePath((configCalls[0][2] as { cwd: string }).cwd)).toBe('/mock/storage/repos/owner-repo/clone');
    });

    it('repairs core.longpaths local config for an existing GitHub clone on Windows', async () => {
      setProcessPlatform('win32');
      let statCallCount = 0;
      vi.mocked(workspace.fs.stat).mockImplementation(async () => {
        statCallCount++;
        if (statCallCount === 1) {
          return { type: 2 } as never;
        }
        throw new Error('not found');
      });

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      expect(vi.mocked(execFile).mock.calls.find(c => c[1]?.includes('clone'))).toBeUndefined();
      const configCalls = getLongpathsConfigCalls();
      expect(configCalls).toHaveLength(1);
      expect(normalizePath((configCalls[0][2] as { cwd: string }).cwd)).toBe('/mock/storage/repos/owner-repo/clone');
    });

    it('persists core.longpaths to a fresh ADO clone local config on Windows', async () => {
      setProcessPlatform('win32');
      mockAdoPrDetails();

      await manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42');

      const configCalls = getLongpathsConfigCalls();
      expect(configCalls).toHaveLength(1);
      expect(normalizePath((configCalls[0][2] as { cwd: string }).cwd)).toBe('/mock/storage/repos/ado-org-project-repo/clone');
    });

    it('repairs core.longpaths local config for an existing ADO clone on Windows', async () => {
      setProcessPlatform('win32');
      mockAdoPrDetails();
      let statCallCount = 0;
      vi.mocked(workspace.fs.stat).mockImplementation(async () => {
        statCallCount++;
        if (statCallCount === 1) {
          return { type: 2 } as never;
        }
        throw new Error('not found');
      });

      await manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42');

      expect(vi.mocked(execFile).mock.calls.find(c => c[1]?.includes('clone'))).toBeUndefined();
      const configCalls = getLongpathsConfigCalls();
      expect(configCalls).toHaveLength(1);
      expect(normalizePath((configCalls[0][2] as { cwd: string }).cwd)).toBe('/mock/storage/repos/ado-org-project-repo/clone');
    });

    it('does not persist core.longpaths local config on non-Windows', async () => {
      setProcessPlatform('linux');

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      expect(getLongpathsConfigCalls()).toHaveLength(0);
    });

    it('includes the clone path when cloning fails', async () => {
      failGitCommand(args => args.includes('clone'), 'Filename too long');

      const message = await rejectedMessage(manager.ensureWorktree('https://github.com/owner/repo/pull/42'));

      expect(message).toContain('Failed to clone repository');
      expect(message).toContain('(repo: /mock/storage/repos/owner-repo/clone)');
      expect(message).toContain('Filename too long');
    });

    it('preserves git exit codes when adding clone failure path context', async () => {
      failGitCommand(args => args.includes('clone'), 'Filename too long');

      await expect(manager.ensureWorktree('https://github.com/owner/repo/pull/42')).rejects.toMatchObject({
        name: 'GitExecError',
        exitCode: 1,
      } satisfies Partial<GitExecError>);
    });

    it('includes the clone path when an ADO clone fails', async () => {
      mockAdoPrDetails();
      failGitCommand(args => args.includes('clone'), 'Filename too long');

      const message = await rejectedMessage(manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42'));

      expect(message).toContain('Failed to clone Azure Repos repository');
      expect(message).toContain('(repo: /mock/storage/repos/ado-org-project-repo/clone)');
      expect(message).toContain('Filename too long');
    });

    it('includes the ADO worktree path when creating an ADO worktree fails', async () => {
      mockAdoPrDetails();
      failGitCommand(
        args => args.includes('worktree') && args.includes('add'),
        'Filename too long',
      );

      const message = await rejectedMessage(manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42'));

      expect(message).toContain('Failed to create ADO worktree');
      expect(message).toContain('(worktree: /mock/storage/repos/ado-org-project-repo/worktrees/pr-42)');
      expect(message).toContain('Filename too long');
    });

    it('includes the clone path when fetching a PR head fails', async () => {
      failGitCommand(
        args => args.includes('fetch') && args.some(arg => arg.includes('pull/42/head')),
        'unable to update local ref',
      );

      const message = await rejectedMessage(manager.ensureWorktree('https://github.com/owner/repo/pull/42'));

      expect(message).toContain('Failed to fetch PR head');
      expect(message).toContain('(repo: /mock/storage/repos/owner-repo/clone)');
      expect(message).toContain('unable to update local ref');
    });

    it('includes the worktree path when creating a worktree fails', async () => {
      failGitCommand(
        args => args.includes('worktree') && args.includes('add'),
        'Filename too long',
      );

      const message = await rejectedMessage(manager.ensureWorktree('https://github.com/owner/repo/pull/42'));

      expect(message).toContain('Failed to create worktree');
      expect(message).toContain('(worktree: /mock/storage/repos/owner-repo/worktrees/pr-42)');
      expect(message).toContain('Filename too long');
    });

    it('passes auth via env vars, not CLI args', async () => {
      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const calls = vi.mocked(execFile).mock.calls;
      // Authenticated operations: clone, fetch PR head, fetch base
      const authCalls = calls.filter(c => {
        const opts = c[2] as { env?: Record<string, string> } | undefined;
        return opts?.env?.GIT_CONFIG_COUNT === '1';
      });
      expect(authCalls.length).toBeGreaterThanOrEqual(3);

      for (const call of authCalls) {
        const opts = call[2] as { env?: Record<string, string> };
        expect(opts.env!.GIT_CONFIG_KEY_0).toBe('http.extraheader');
        expect(opts.env!.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);

        // Token must NOT appear in CLI args
        const args = call[1] as string[];
        expect(args.some(a => a.includes('http.extraheader'))).toBe(false);
        expect(args.some(a => a.includes('Authorization'))).toBe(false);
      }
    });

    it('fetches PR ref and base ref', async () => {
      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const calls = vi.mocked(execFile).mock.calls;
      const fetchCalls = calls.filter(c => c[1]?.includes('fetch'));
      expect(fetchCalls.length).toBeGreaterThanOrEqual(2);

      // Should fetch PR head
      const prFetch = fetchCalls.find(c => c[1]?.some((a: string) => a.includes('pull/42/head')));
      expect(prFetch).toBeDefined();

      // Should fetch base branch (via refs/heads/)
      const baseFetch = fetchCalls.find(c => c[1]?.some((a: string) => a.includes('refs/heads/main')));
      expect(baseFetch).toBeDefined();
    });

    it('creates a worktree', async () => {
      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const calls = vi.mocked(execFile).mock.calls;
      const worktreeCall = calls.find(c =>
        c[1]?.includes('worktree') && c[1]?.includes('add'),
      );
      expect(worktreeCall).toBeDefined();
    });

    it('removes and re-clones an existing clone directory that is not a valid git repo', async () => {
      const clonePath = '/mock/storage/repos/owner-repo/clone';
      mockExistingDirectories([clonePath]);
      mockGitDirectoryValidationFailure(clonePath);

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const deletedPaths = vi.mocked(workspace.fs.delete).mock.calls.map(
        call => normalizePath((call[0] as { fsPath: string }).fsPath),
      );
      expect(deletedPaths).toContain(clonePath);
      const cloneCall = vi.mocked(execFile).mock.calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall).toBeDefined();
    });

    it('does not remove a clone directory when git validation fails unexpectedly', async () => {
      const clonePath = '/mock/storage/repos/owner-repo/clone';
      mockExistingDirectories([clonePath]);
      mockGitDirectoryValidationFailure(clonePath, 'fatal: permission denied');

      await expect(manager.ensureWorktree('https://github.com/owner/repo/pull/42'))
        .rejects.toThrow('git rev-parse failed: fatal: permission denied');

      expect(workspace.fs.delete).not.toHaveBeenCalled();
      const cloneCall = vi.mocked(execFile).mock.calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall).toBeUndefined();
    });

    it('reuses an existing clone directory that is a valid git repo', async () => {
      const clonePath = '/mock/storage/repos/owner-repo/clone';
      mockExistingDirectories([clonePath]);

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const calls = vi.mocked(execFile).mock.calls;
      const revParseCall = calls.find(c => c[1]?.includes('rev-parse'));
      expect(normalizePath((revParseCall?.[2] as { cwd: string }).cwd)).toBe(clonePath);
      expect(revParseCall?.[1]).toContain('--resolve-git-dir');
      expect(revParseCall?.[1]?.some(arg => normalizePath(arg) === `${clonePath}/.git`)).toBe(true);
      const cloneCall = calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall).toBeUndefined();
      expect(workspace.fs.delete).not.toHaveBeenCalled();
    });

    it('removes and re-clones an existing ADO clone directory that is not a valid git repo', async () => {
      const clonePath = '/mock/storage/repos/ado-org-project-repo/clone';
      mockAdoPrDetails();
      mockExistingDirectories([clonePath]);
      mockGitDirectoryValidationFailure(clonePath);

      await manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42');

      const deletedPaths = vi.mocked(workspace.fs.delete).mock.calls.map(
        call => normalizePath((call[0] as { fsPath: string }).fsPath),
      );
      expect(deletedPaths).toContain(clonePath);
      const cloneCall = vi.mocked(execFile).mock.calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall).toBeDefined();
    });

    it('removes and recreates an existing worktree directory that is not a valid git worktree', async () => {
      const clonePath = '/mock/storage/repos/owner-repo/clone';
      const worktreePath = '/mock/storage/repos/owner-repo/worktrees/pr-42';
      mockExistingDirectories([clonePath, worktreePath]);
      mockGitDirectoryValidationFailure(worktreePath);

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const deletedPaths = vi.mocked(workspace.fs.delete).mock.calls.map(
        call => normalizePath((call[0] as { fsPath: string }).fsPath),
      );
      expect(deletedPaths).toContain(worktreePath);
      const calls = vi.mocked(execFile).mock.calls;
      const pruneCallIndex = calls.findIndex(c => c[1]?.includes('worktree') && c[1]?.includes('prune'));
      expect(pruneCallIndex).toBeGreaterThanOrEqual(0);
      expect(normalizePath((calls[pruneCallIndex][2] as { cwd: string }).cwd)).toBe(clonePath);
      const worktreeAddCallIndex = calls.findIndex(c => c[1]?.includes('worktree') && c[1]?.includes('add'));
      expect(worktreeAddCallIndex).toBeGreaterThan(pruneCallIndex);
      const resetCall = calls.find(c => c[1]?.includes('reset'));
      expect(resetCall).toBeUndefined();
    });

    it('updates an existing worktree directory that is a valid git worktree', async () => {
      const clonePath = '/mock/storage/repos/owner-repo/clone';
      const worktreePath = '/mock/storage/repos/owner-repo/worktrees/pr-42';
      mockExistingDirectories([clonePath, worktreePath]);

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const calls = vi.mocked(execFile).mock.calls;
      const resetCall = calls.find(c => c[1]?.includes('reset') && c[1]?.includes('--hard'));
      expect(resetCall).toBeDefined();
      expect(normalizePath((resetCall?.[2] as { cwd: string }).cwd)).toBe(worktreePath);
      const worktreeAddCall = calls.find(c => c[1]?.includes('worktree') && c[1]?.includes('add'));
      expect(worktreeAddCall).toBeUndefined();
      expect(workspace.fs.delete).not.toHaveBeenCalled();
    });

    it('removes and recreates an existing ADO worktree directory that is not a valid git worktree', async () => {
      const clonePath = '/mock/storage/repos/ado-org-project-repo/clone';
      const worktreePath = '/mock/storage/repos/ado-org-project-repo/worktrees/pr-42';
      mockAdoPrDetails();
      mockExistingDirectories([clonePath, worktreePath]);
      mockGitDirectoryValidationFailure(worktreePath);

      await manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42');

      const deletedPaths = vi.mocked(workspace.fs.delete).mock.calls.map(
        call => normalizePath((call[0] as { fsPath: string }).fsPath),
      );
      expect(deletedPaths).toContain(worktreePath);
      const calls = vi.mocked(execFile).mock.calls;
      const pruneCallIndex = calls.findIndex(c => c[1]?.includes('worktree') && c[1]?.includes('prune'));
      expect(pruneCallIndex).toBeGreaterThanOrEqual(0);
      expect(normalizePath((calls[pruneCallIndex][2] as { cwd: string }).cwd)).toBe(clonePath);
      const worktreeAddCallIndex = calls.findIndex(c => c[1]?.includes('worktree') && c[1]?.includes('add'));
      expect(worktreeAddCallIndex).toBeGreaterThan(pruneCallIndex);
      const resetCall = calls.find(c => c[1]?.includes('reset'));
      expect(resetCall).toBeUndefined();
    });

    it('calls GitHub API for PR metadata', async () => {
      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/pulls/42',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
          }),
        }),
      );
    });

    it('throws when baseRef contains unsafe characters', async () => {
      const unsafeRefs = [
        'main`whoami`',
        'branch$(cmd)',
        'ref with spaces',
        'ref\tnewline',
        'ref;drop',
        '-flag',
        'branch**glob',
        'ref<script>',
        '',
      ];
      for (const ref of unsafeRefs) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({
            base: { ref },
            head: { sha: 'abc123' },
          }),
        }));

        await expect(
          manager.ensureWorktree('https://github.com/owner/repo/pull/42'),
        ).rejects.toThrow('Invalid base ref from GitHub API');
      }
    });

    it('allows valid baseRef values', async () => {
      const validRefs = ['main', 'release/v1.0', 'feature/my_branch', 'my.branch-name'];
      for (const ref of validRefs) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({
            base: { ref },
            head: { sha: 'abc123' },
          }),
        }));

        const info = await manager.ensureWorktree(`https://github.com/owner/repo/pull/42`);
        expect(info.baseRef).toBe(`origin/${ref}`);
      }
    });

    it('throws when GitHub auth fails', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue(null as never);

      await expect(
        manager.ensureWorktree('https://github.com/owner/repo/pull/42'),
      ).rejects.toThrow('GitHub authentication required');
    });

    it('throws when GitHub API returns non-OK', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      // Need to make stat fail (clone doesn't exist) so we get past clone step
      // But clone will fail too because execFile default returns empty... let's mock
      // the API call happening before clone issues
      await expect(
        manager.ensureWorktree('https://github.com/owner/repo/pull/42'),
      ).rejects.toThrow();
    });

    it('throws when git version is too old', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if ((args as string[])?.includes('version')) {
            cb(null, 'git version 2.30.0', '');
          } else {
            cb(null, '', '');
          }
        },
      );

      await expect(
        manager.ensureWorktree('https://github.com/owner/repo/pull/42'),
      ).rejects.toThrow(/git 2\.30 is too old/);
    });

    it('throws when git version is unparseable', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if ((args as string[])?.includes('version')) {
            cb(null, 'unknown output', '');
          } else {
            cb(null, '', '');
          }
        },
      );

      await expect(
        manager.ensureWorktree('https://github.com/owner/repo/pull/42'),
      ).rejects.toThrow(/Could not determine git version/);
    });

    it('stores worktree info for quick lookup', async () => {
      const url = 'https://github.com/owner/repo/pull/42';
      const info = await manager.ensureWorktree(url);

      const lookup = manager.getWorktreeInfo(url);
      expect(lookup).toBeDefined();
      expect(lookup?.prNumber).toBe('42');
      expect(lookup).toBe(info);
    });

    it('creates an ADO worktree using Microsoft auth and PR refs', async () => {
      mockAdoPrDetails();

      const url = 'https://dev.azure.com/org/project/_git/repo/pullrequest/42';
      const info = await manager.ensureWorktree(url);

      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { createIfNone: true },
      );
      expect(info.provider).toBe('ado');
      expect(info.prUrl).toBe(url);
      expect(info.baseRef).toBe('refs/devdocket/ado/pr-42-base');
      expect(info.headRef).toBe('refs/devdocket/ado/pr-42-head');

      const calls = vi.mocked(execFile).mock.calls;
      const authCalls = calls.filter(c => {
        const opts = c[2] as { env?: Record<string, string> } | undefined;
        return opts?.env?.GIT_CONFIG_VALUE_0 === 'Authorization: Bearer mock-token';
      });
      expect(authCalls.length).toBeGreaterThanOrEqual(3);
      const cloneCall = calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall?.[1]).toContain('https://dev.azure.com/org/project/_git/repo');
      expect(calls.some(c => c[1]?.some((arg: string) => arg.includes('+refs/heads/feature/add-api:refs/devdocket/ado/pr-42-head')))).toBe(true);
      expect(calls.some(c => c[1]?.some((arg: string) => arg.includes('+refs/heads/main:refs/devdocket/ado/pr-42-base')))).toBe(true);
    });
  });

  describe('getWorktreeInfo', () => {
    it('returns undefined for unknown PR URL', () => {
      expect(manager.getWorktreeInfo('https://github.com/owner/repo/pull/99')).toBeUndefined();
    });

    it('returns undefined for invalid URL', () => {
      expect(manager.getWorktreeInfo('not-a-url')).toBeUndefined();
    });
  });

  describe('removeWorktree', () => {
    it('calls git worktree remove for known worktree', async () => {
      // First create a worktree
      const url = 'https://github.com/owner/repo/pull/42';
      await manager.ensureWorktree(url);
      vi.clearAllMocks();

      await manager.removeWorktree(url);

      const calls = vi.mocked(execFile).mock.calls;
      const removeCall = calls.find(c =>
        c[1]?.includes('worktree') && c[1]?.includes('remove'),
      );
      expect(removeCall).toBeDefined();
    });

    it('does nothing for unknown PR URL', async () => {
      await manager.removeWorktree('https://github.com/owner/repo/pull/99');
      // Should not throw
    });
  });

  describe('removeRepo', () => {
    it('deletes the clone directory', async () => {
      await manager.removeRepo('owner', 'repo');

      expect(workspace.fs.delete).toHaveBeenCalled();
    });

    it('deletes the actual ADO repo directory for cached ADO worktrees', async () => {
      mockAdoPrDetails();
      await manager.ensureWorktree('https://dev.azure.com/org/project/_git/repo/pullrequest/42');
      vi.mocked(workspace.fs.delete).mockClear();

      await manager.removeRepo('org/project', 'repo');

      const deletedPaths = vi.mocked(workspace.fs.delete).mock.calls.map(call => (call[0] as { fsPath: string }).fsPath.replace(/\\/g, '/'));
      expect(deletedPaths).toContain('/mock/storage/repos/ado-org-project-repo');
    });

    it('includes the ADO repo directory fallback after reload when no worktrees are cached', async () => {
      await manager.removeRepo('org/project', 'repo');

      const deletedPaths = vi.mocked(workspace.fs.delete).mock.calls.map(call => (call[0] as { fsPath: string }).fsPath.replace(/\\/g, '/'));
      expect(deletedPaths).toContain('/mock/storage/repos/org-project-repo');
      expect(deletedPaths).toContain('/mock/storage/repos/ado-org-project-repo');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authentication, workspace, mockLogOutputChannel } from 'vscode';
import { RepoManager, parsePrUrl } from '../repoManager';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, '', '');
  }),
}));

import { execFile } from 'child_process';

function createRepoManager(): RepoManager {
  return new RepoManager({ fsPath: '/mock/storage' } as never, mockLogOutputChannel as never);
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
      await expect(manager.ensureWorktree('not-a-url')).rejects.toThrow('Invalid GitHub PR URL');
    });

    it('calls git clone for a fresh repo', async () => {
      const item = 'https://github.com/owner/repo/pull/42';
      await manager.ensureWorktree(item);

      const calls = vi.mocked(execFile).mock.calls;
      const cloneCall = calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall).toBeDefined();
      expect(cloneCall![1]).toContain('--no-checkout');
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

    it('reuses existing clone (stat returns success for clone dir)', async () => {
      // Make stat succeed for clone dir only (first call)
      let statCallCount = 0;
      vi.mocked(workspace.fs.stat).mockImplementation(async () => {
        statCallCount++;
        if (statCallCount === 1) {
          // Clone dir exists
          return { type: 2 } as never;
        }
        // Worktree dir does not exist
        throw new Error('not found');
      });

      await manager.ensureWorktree('https://github.com/owner/repo/pull/42');

      const calls = vi.mocked(execFile).mock.calls;
      const cloneCall = calls.find(c => c[1]?.includes('clone'));
      expect(cloneCall).toBeUndefined(); // Should not clone again
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

    it('stores worktree info for quick lookup', async () => {
      const url = 'https://github.com/owner/repo/pull/42';
      const info = await manager.ensureWorktree(url);

      const lookup = manager.getWorktreeInfo(url);
      expect(lookup).toBeDefined();
      expect(lookup?.prNumber).toBe('42');
      expect(lookup).toBe(info);
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
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window, workspace, env, Uri } from 'vscode';
import { GitHubActionsProvider } from '../githubActionsProvider';
import { initLogger, LogLevel } from '../logger';

const mockFetch = vi.fn();

function createMockRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null = null,
  repo = 'owner/repo',
  branch = 'main',
) {
  return {
    id,
    name,
    run_number: id,
    status,
    conclusion,
    head_branch: branch,
    html_url: `https://github.com/${repo}/actions/runs/${id}`,
    event: 'push',
    repository: { full_name: repo },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:01:00Z',
  };
}

function createMockJob(
  id: number,
  name: string,
  status: string,
  conclusion: string | null = null,
) {
  return {
    id,
    name,
    status,
    conclusion,
    html_url: `https://github.com/owner/repo/actions/runs/1/jobs/${id}`,
  };
}

describe('GitHubActionsProvider', () => {
  let provider: GitHubActionsProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubActionsProvider();

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['owner/repo']; }
        return defaultValue;
      }),
    } as any);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['repo'],
      account: { id: '1', label: 'testuser' },
    } as any);

    vi.mocked(window.showInformationMessage).mockResolvedValue(undefined as any);
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('has correct id and label', () => {
    expect(provider.id).toBe('github-actions');
    expect(provider.label).toBe('GitHub Actions');
  });

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('emits empty items when no repos are configured', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return []; }
        return defaultValue;
      }),
    } as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
  });

  it('emits discovered items for active workflow runs', async () => {
    const runs = [
      createMockRun(1, 'CI', 'in_progress', null, 'owner/repo', 'feature-branch'),
      createMockRun(2, 'Deploy', 'queued', null, 'owner/repo', 'main'),
      createMockRun(3, 'Tests', 'completed', 'success', 'owner/repo', 'main'),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: runs }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobs: [] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    // Only non-completed runs should be emitted
    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('actions:owner/repo/runs/1');
    expect(items[0].title).toBe('CI #1');
    expect(items[0].group).toBe('owner/repo');
    expect(items[0].state).toBe('in_progress');
    expect(items[1].externalId).toBe('actions:owner/repo/runs/2');
    expect(items[1].title).toBe('Deploy #2');
    expect(items[1].state).toBe('queued');
  });

  it('fires a success notification when a run transitions to completed:success', async () => {
    // First refresh: run is in_progress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'in_progress', null, 'owner/repo', 'main')],
      }),
    });
    await provider.refresh();

    // Second refresh: run is completed:success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'completed', 'success', 'owner/repo', 'main')],
      }),
    });
    await provider.refresh();

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      '✅ CI #1 succeeded (owner/repo, main)',
      'View Run',
    );
  });

  it('fires a failure notification when a run transitions to completed:failure', async () => {
    // First refresh: run is in_progress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'in_progress', null, 'owner/repo', 'feat')],
      }),
    });
    await provider.refresh();

    // Second refresh: run has failed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'completed', 'failure', 'owner/repo', 'feat')],
      }),
    });
    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      '❌ CI #1 failed (owner/repo, feat)',
      'View Run',
    );
  });

  it('does not fire notification on first refresh (items are new)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'completed', 'failure', 'owner/repo', 'main')],
      }),
    });
    await provider.refresh();

    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('does not fire notification when status is unchanged', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'in_progress')],
      }),
    });
    await provider.refresh();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'in_progress')],
      }),
    });
    await provider.refresh();

    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('opens the run URL when user clicks View Run on success', async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce('View Run' as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [createMockRun(1, 'CI', 'in_progress')] }),
    });
    await provider.refresh();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [createMockRun(1, 'CI', 'completed', 'success')] }),
    });
    await provider.refresh();

    expect(env.openExternal).toHaveBeenCalledTimes(1);
    expect(Uri.parse).toHaveBeenCalledWith('https://github.com/owner/repo/actions/runs/1');
  });

  it('fires early job failure notification for failed jobs in in-progress runs', async () => {
    const run = createMockRun(1, 'CI', 'in_progress', null, 'owner/repo', 'main');

    // First call: workflow runs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [run] }),
    });
    // Second call: jobs for this run (called because it's in_progress)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jobs: [
          createMockJob(10, 'build', 'completed', 'failure'),
          createMockJob(11, 'test', 'in_progress', null),
        ],
      }),
    });

    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      '⚠️ Job "build" failed in CI #1 (owner/repo, main)',
      'View Job',
    );
  });

  it('does not re-notify the same job failure on subsequent refreshes', async () => {
    const run = createMockRun(1, 'CI', 'in_progress', null, 'owner/repo', 'main');
    const jobs = [createMockJob(10, 'build', 'completed', 'failure')];

    // First refresh
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [run] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobs }),
    });
    await provider.refresh();

    vi.mocked(window.showWarningMessage).mockClear();

    // Second refresh — same in-progress run, same failed job
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [run] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobs }),
    });
    await provider.refresh();

    // Should not re-notify for the same job failure
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('fetches from multiple repos', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['owner/repo1', 'owner/repo2']; }
        return defaultValue;
      }),
    } as any);

    // Repo 1 runs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'in_progress', null, 'owner/repo1')],
      }),
    });
    // Repo 2 runs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(2, 'Deploy', 'queued', null, 'owner/repo2')],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0].group).toBe('owner/repo1');
    expect(items[1].group).toBe('owner/repo2');
  });

  it('includes description with branch, event, and status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'in_progress', null, 'owner/repo', 'my-feature')],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toBe('my-feature · push · in_progress');
  });

  it('skips invalid repo identifiers and does not make API calls for them', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['not-a-repo', '../traversal/attack', 'valid/repo']; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [createMockRun(1, 'CI', 'completed', 'success', 'valid/repo')],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Only one fetch call — for the valid repo (no job fetch since run is completed)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // Completed runs are not emitted as items
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(0);
  });
});

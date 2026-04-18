import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window, env, Uri } from 'vscode';
import { AdoPipelineProvider } from '../adoPipelineProvider';
import { initLogger, LogLevel } from '../logger';

const mockFetch = vi.fn();

function createMockBuild(
  id: number,
  defName: string,
  status: string,
  result: string | null = null,
  project = 'MyProject',
  branch = 'refs/heads/main',
) {
  return {
    id,
    buildNumber: `20240115.${id}`,
    status,
    result,
    definition: { name: defName },
    sourceBranch: branch,
    _links: { web: { href: `https://dev.azure.com/myorg/${project}/_build/results?buildId=${id}` } },
    project: { name: project },
    startTime: '2024-01-15T10:00:00Z',
    finishTime: null,
  };
}

function createMockTimelineRecord(
  id: string,
  name: string,
  type: string,
  state: string,
  result: string | null = null,
) {
  return { id, name, type, state, result };
}

describe('AdoPipelineProvider', () => {
  let provider: AdoPipelineProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    provider = new AdoPipelineProvider([{ org: 'myorg', projects: ['MyProject'] }]);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: [],
      account: { id: 'acc-1', label: 'testuser' },
    } as any);

    vi.mocked(window.showInformationMessage).mockResolvedValue(undefined as any);
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('has correct id and label', () => {
    expect(provider.id).toBe('ado-pipelines');
    expect(provider.label).toBe('Azure DevOps Pipelines');
  });

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(null as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
  });

  it('emits discovered items for active pipeline builds', async () => {
    const builds = [
      createMockBuild(1, 'CI Pipeline', 'inProgress', null, 'MyProject', 'refs/heads/feature'),
      createMockBuild(2, 'Deploy', 'notStarted', null, 'MyProject', 'refs/heads/main'),
      createMockBuild(3, 'Tests', 'completed', 'succeeded', 'MyProject'),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ count: builds.length, value: builds }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    // Only non-completed builds should be emitted
    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('pipelines:MyProject/builds/1');
    expect(items[0].title).toBe('CI Pipeline #20240115.1');
    expect(items[0].group).toBe('MyProject');
    expect(items[0].state).toBe('inProgress');
    expect(items[1].externalId).toBe('pipelines:MyProject/builds/2');
    expect(items[1].title).toBe('Deploy #20240115.2');
  });

  it('fires a success notification when a build transitions to completed:succeeded', async () => {
    // First refresh: build is inProgress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'inProgress', null, 'MyProject', 'refs/heads/main')],
      }),
    });
    // Job fetch for in-progress build
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });
    await provider.refresh();

    // Second refresh: build is completed:succeeded
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'completed', 'succeeded', 'MyProject', 'refs/heads/main')],
      }),
    });
    await provider.refresh();

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      '✅ CI #20240115.1 succeeded (MyProject, main)',
      'View Build',
    );
  });

  it('fires a failure notification when a build transitions to completed:failed', async () => {
    // First refresh: build is inProgress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'inProgress', null, 'MyProject', 'refs/heads/feat')],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });
    await provider.refresh();

    // Second refresh: build has failed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'completed', 'failed', 'MyProject', 'refs/heads/feat')],
      }),
    });
    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      '❌ CI #20240115.1 failed (MyProject, feat)',
      'View Build',
    );
  });

  it('does not fire notification on first refresh (items are new)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'completed', 'failed')],
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
        value: [createMockBuild(1, 'CI', 'inProgress')],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });
    await provider.refresh();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'inProgress')],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });
    await provider.refresh();

    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('opens the build URL when user clicks View Build on success', async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce('View Build' as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [createMockBuild(1, 'CI', 'inProgress')] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });
    await provider.refresh();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [createMockBuild(1, 'CI', 'completed', 'succeeded')] }),
    });
    await provider.refresh();

    expect(env.openExternal).toHaveBeenCalledTimes(1);
  });

  it('fires early job failure notification for failed jobs in in-progress builds', async () => {
    // Build is in-progress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'inProgress', null, 'MyProject', 'refs/heads/main')],
      }),
    });
    // Timeline for this build has a failed job
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        records: [
          createMockTimelineRecord('j1', 'Build', 'Job', 'completed', 'failed'),
          createMockTimelineRecord('j2', 'Test', 'Job', 'inProgress', null),
          createMockTimelineRecord('s1', 'Stage 1', 'Stage', 'inProgress', null),
        ],
      }),
    });

    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      '⚠️ Job "Build" failed in CI #20240115.1 (MyProject, main)',
      'View Build',
    );
  });

  it('does not re-notify the same job failure on subsequent refreshes', async () => {
    const build = createMockBuild(1, 'CI', 'inProgress', null, 'MyProject', 'refs/heads/main');
    const records = [createMockTimelineRecord('j1', 'Build', 'Job', 'completed', 'failed')];

    // First refresh
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [build] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ records }) });
    await provider.refresh();

    vi.mocked(window.showWarningMessage).mockClear();

    // Second refresh — same build, same failed job
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [build] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ records }) });
    await provider.refresh();

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

    expect(listener).toHaveBeenCalledWith([]);
  });

  it('strips refs/heads/ prefix from branch in description', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [createMockBuild(1, 'CI', 'inProgress', null, 'MyProject', 'refs/heads/my-branch')],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toBe('my-branch · inProgress');
  });
});

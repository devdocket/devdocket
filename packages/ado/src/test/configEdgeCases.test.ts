import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace, extensions } from 'vscode';
import { AdoWorkItemProvider } from '../adoWorkItemProvider';
import { AdoPrReviewProvider } from '../adoPrReviewProvider';
import { parseAdoProjectsConfig } from '../configParser';

const mockFetch = vi.fn();

describe('ADO provider config edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('refreshIntervalSeconds edge cases', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not start timer for zero interval', () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(0);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });

    it('does not start timer for negative interval', () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(-5);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });

    it('does not start timer for NaN interval', () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(NaN);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });

    it('does not start timer for Infinity', () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(Infinity);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });

    it('clamps interval below 60s up to 60s', () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(10);

      vi.advanceTimersByTime(10_000);
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50_000); // total 60s
      expect(spy).toHaveBeenCalledTimes(1);

      provider.dispose();
    });

    it('PR review provider also rejects NaN interval', () => {
      const provider = new AdoPrReviewProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(NaN);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });

    it('PR review provider also rejects negative interval', () => {
      const provider = new AdoPrReviewProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(-100);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });

    it('PR review provider also rejects Infinity interval', () => {
      const provider = new AdoPrReviewProvider([{ org: 'myorg', projects: [] }]);
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(Infinity);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      provider.dispose();
    });
  });

  describe('organization config edge cases', () => {
    // With the new config parser, providers are created when orgConfigs is non-empty

    it('no configuration at all yields no org configs', () => {
      const result = parseAdoProjectsConfig([]);
      expect(result).toHaveLength(0);
    });
  });

  describe('projects config edge cases', () => {
    it('empty string project results in org-level WIQL URL', async () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [''] }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Empty string project → projectPath = '' → org-level URL
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1',
        expect.any(Object),
      );

      provider.dispose();
    });

    it('mix of empty and valid projects fetches both paths', async () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['', 'RealProject'] }]);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ workItems: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ workItems: [] }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First call: org-level (empty project)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1',
        expect.any(Object),
      );
      // Second call: project-level
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev.azure.com/myorg/RealProject/_apis/wit/wiql?api-version=7.1',
        expect.any(Object),
      );

      provider.dispose();
    });

    it('project with special characters is URL-encoded', async () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['My Project'] }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev.azure.com/myorg/My%20Project/_apis/wit/wiql?api-version=7.1',
        expect.any(Object),
      );

      provider.dispose();
    });

    it('no projects array falls back to org-level query', async () => {
      const provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1',
        expect.any(Object),
      );

      provider.dispose();
    });
  });

  describe('config change events', () => {
    // Extension.ts listens for changes to workcenterAdo.* keys
    // and calls configureProviders() to dispose/recreate providers

    it('affectsConfiguration matches all ADO config keys', () => {
      const relevantKeys = [
        'workcenterAdo.projects',
        'workcenterAdo.refreshIntervalSeconds',
      ];

      for (const key of relevantKeys) {
        const event = { affectsConfiguration: (k: string) => k === key };
        const shouldReconfigure =
          event.affectsConfiguration('workcenterAdo.projects') ||
          event.affectsConfiguration('workcenterAdo.refreshIntervalSeconds');
        expect(shouldReconfigure).toBe(true);
      }
    });

    it('unrelated config changes do not trigger reconfiguration', () => {
      const unrelatedKeys = [
        'workcenter.logLevel',
        'workcenterGithub.repos',
        'editor.fontSize',
      ];

      for (const key of unrelatedKeys) {
        const event = { affectsConfiguration: (k: string) => k === key };
        const shouldReconfigure =
          event.affectsConfiguration('workcenterAdo.projects') ||
          event.affectsConfiguration('workcenterAdo.refreshIntervalSeconds');
        expect(shouldReconfigure).toBe(false);
      }
    });
  });

  describe('ADO extension activate — config-driven provider lifecycle', () => {
    let configValues: Record<string, any>;
    let configChangeListeners: ((e: any) => void)[];
    let mockRegisterProvider: ReturnType<typeof vi.fn>;
    let context: any;

    beforeEach(() => {
      configValues = {
        projects: ['myorg/ProjectA'],
        refreshIntervalSeconds: 0, // Disable timers to prevent leaks in tests
      };
      configChangeListeners = [];
      mockRegisterProvider = vi.fn(() => ({ dispose: vi.fn() }));

      vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => ({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (section === 'workcenterAdo') {
            return configValues[key] ?? defaultValue;
          }
          return defaultValue;
        }),
      }) as any);

      vi.mocked(workspace.onDidChangeConfiguration).mockImplementation((listener: any) => {
        configChangeListeners.push(listener);
        return { dispose: vi.fn() };
      });

      vi.mocked(extensions.getExtension).mockReturnValue({
        isActive: true,
        exports: {
          registerProvider: mockRegisterProvider,
          registerAction: vi.fn(() => ({ dispose: vi.fn() })),
        },
        activate: vi.fn(),
      } as any);

      context = {
        globalStorageUri: { fsPath: 'mock-storage' },
        subscriptions: [] as { dispose: () => void }[],
      };
    });

    afterEach(() => {
      for (const sub of context.subscriptions) {
        sub.dispose();
      }
    });

    it('does not register providers when no organizations are configured', async () => {
      configValues.projects = [];

      const { activate } = await import('../extension');
      await activate(context);

      expect(mockRegisterProvider).not.toHaveBeenCalled();
    });

    it('registers providers when projects are set', async () => {
      const { activate } = await import('../extension');
      await activate(context);

      expect(mockRegisterProvider).toHaveBeenCalledTimes(2);
    });

    it('reconfigures providers on projects change', async () => {
      const { activate } = await import('../extension');
      await activate(context);

      expect(mockRegisterProvider).toHaveBeenCalledTimes(2);

      // Change projects
      configValues.projects = ['myorg/NewProject'];
      for (const listener of configChangeListeners) {
        listener({ affectsConfiguration: (k: string) => k === 'workcenterAdo.projects' });
      }

      // New providers registered
      expect(mockRegisterProvider).toHaveBeenCalledTimes(4);
    });

    it('reconfigures providers on refreshInterval change', async () => {
      const { activate } = await import('../extension');
      await activate(context);

      expect(mockRegisterProvider).toHaveBeenCalledTimes(2);

      configValues.refreshIntervalSeconds = 0;
      for (const listener of configChangeListeners) {
        listener({
          affectsConfiguration: (k: string) => k === 'workcenterAdo.refreshIntervalSeconds',
        });
      }

      expect(mockRegisterProvider).toHaveBeenCalledTimes(4);
    });
  });
});

import { DevDocketApiImpl } from '../api/devDocketApi';
import { DevDocketProvider, DevDocketAction, ProviderItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { WorkGraph } from '../services/workGraph';
import { ITaskStore } from '../storage/taskStore';
import * as vscode from 'vscode';
import { InboxState } from '../storage/discoveredStateStore';
import { describe, it, expect, vi, beforeEach } from 'vitest';

function createMockStateStore() {
  const cache = new Map<string, InboxState>();
  return {
    getState: vi.fn((providerId: string, externalId: string) =>
      cache.get(`${providerId}::${externalId}`),
    ),
    setState: vi.fn(async (providerId: string, externalId: string, state: InboxState) => {
      cache.set(`${providerId}::${externalId}`, state);
    }),
    setStates: vi.fn(async (items: Array<{ providerId: string; externalId: string; state: InboxState }>) => {
      for (const item of items) {
        cache.set(`${item.providerId}::${item.externalId}`, item.state);
      }
    }),
    load: vi.fn(async () => {}),
    loadAll: vi.fn(async () => []),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  } as unknown as import('../storage/discoveredStateStore').DiscoveredStateStore;
}

function createMockProvider(id: string): DevDocketProvider {
  const emitter = new vscode.EventEmitter<ProviderItem[]>();
  return {
    id,
    label: `Provider ${id}`,
    onDidDiscoverItems: emitter.event,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAction(id: string): DevDocketAction {
  return {
    id,
    label: `Action ${id}`,
    canRun: vi.fn().mockReturnValue(true),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

// Contract tests for the public API surface that provider extensions consume.
// These intentionally overlap with registry-level tests to guard against
// accidental wiring changes in DevDocketApiImpl.
describe('DevDocketApiImpl', () => {
  let api: DevDocketApiImpl;
  let providerRegistry: ProviderRegistry;
  let actionRegistry: ActionRegistry;
  let watcherRegistry: WatcherRegistry;
  let prWatcherRegistry: PRWatcherRegistry;
  let workGraph: WorkGraph;

  beforeEach(async () => {
    const stateStore = createMockStateStore();
    providerRegistry = new ProviderRegistry(stateStore);
    actionRegistry = new ActionRegistry();
    watcherRegistry = new WatcherRegistry({ info: vi.fn(), warn: vi.fn() });
    prWatcherRegistry = new PRWatcherRegistry({ info: vi.fn(), warn: vi.fn() });
    workGraph = new WorkGraph(createMockStore());
    await workGraph.load();
    api = new DevDocketApiImpl(providerRegistry, actionRegistry, watcherRegistry, prWatcherRegistry, workGraph);
  });

  describe('registerProvider', () => {
    it('delegates to providerRegistry.register', () => {
      const provider = createMockProvider('test-provider');
      const spy = vi.spyOn(providerRegistry, 'register');

      api.registerProvider(provider);

      expect(spy).toHaveBeenCalledWith(provider);
    });

    it('returns a Disposable that unregisters the provider', () => {
      const provider = createMockProvider('test-provider');
      const disposable = api.registerProvider(provider);

      expect(providerRegistry.hasProviders).toBe(true);

      disposable.dispose();

      expect(providerRegistry.hasProviders).toBe(false);
    });

    it('supports registering multiple providers', () => {
      const p1 = createMockProvider('provider-1');
      const p2 = createMockProvider('provider-2');

      api.registerProvider(p1);
      api.registerProvider(p2);

      expect(providerRegistry.hasProviders).toBe(true);
      expect(providerRegistry.getProvider('provider-1')).toBe(p1);
      expect(providerRegistry.getProvider('provider-2')).toBe(p2);
    });

    it('throws when registering a duplicate provider id', () => {
      const p1 = createMockProvider('dup');
      const p2 = createMockProvider('dup');

      api.registerProvider(p1);

      expect(() => api.registerProvider(p2)).toThrow('Provider already registered: dup');
    });
  });

  describe('getProviderItem', () => {
    it('looks up the live discovered item by provider and external id', () => {
      const emitter = new vscode.EventEmitter<ProviderItem[]>();
      const provider: DevDocketProvider = {
        id: 'test-provider',
        label: 'Test Provider',
        onDidDiscoverItems: emitter.event,
        refresh: vi.fn().mockResolvedValue(undefined),
      };
      const item: ProviderItem = { externalId: 'item-1', title: 'Item 1' };

      api.registerProvider(provider);
      emitter.fire([item]);

      expect(api.getProviderItem('test-provider', 'item-1')).toBe(item);
      expect(api.getProviderItem('test-provider', 'missing')).toBeUndefined();
      expect(api.getProviderItem('missing-provider', 'item-1')).toBeUndefined();
    });
  });

  describe('registerAction', () => {
    it('delegates to actionRegistry.register', () => {
      const action = createMockAction('test-action');
      const spy = vi.spyOn(actionRegistry, 'register');

      api.registerAction(action);

      expect(spy).toHaveBeenCalledWith(action);
    });

    it('returns a Disposable that unregisters the action', () => {
      const action = createMockAction('test-action');
      const disposable = api.registerAction(action);

      expect(actionRegistry.getAction('test-action')).toBe(action);

      disposable.dispose();

      expect(actionRegistry.getAction('test-action')).toBeUndefined();
    });

    it('supports registering multiple actions', () => {
      const a1 = createMockAction('action-1');
      const a2 = createMockAction('action-2');

      api.registerAction(a1);
      api.registerAction(a2);

      expect(actionRegistry.getAction('action-1')).toBe(a1);
      expect(actionRegistry.getAction('action-2')).toBe(a2);
    });

    it('throws when registering a duplicate action id', () => {
      const a1 = createMockAction('dup');
      const a2 = createMockAction('dup');

      api.registerAction(a1);

      expect(() => api.registerAction(a2)).toThrow('Action already registered: dup');
    });
  });

  describe('registerRunWatcher', () => {
    it('delegates to watcherRegistry.register', () => {
      const watcher = {
        id: 'test-watcher',
        label: 'Test Watcher',
        canWatch: vi.fn(),
        parseRunUrl: vi.fn(),
        getRunStatus: vi.fn(),
      };
      const spy = vi.spyOn(watcherRegistry, 'register');

      api.registerRunWatcher(watcher);

      expect(spy).toHaveBeenCalledWith(watcher);
    });

    it('returns a Disposable that unregisters the watcher', () => {
      const watcher = {
        id: 'test-watcher',
        label: 'Test Watcher',
        canWatch: vi.fn(),
        parseRunUrl: vi.fn(),
        getRunStatus: vi.fn(),
      };
      const disposable = api.registerRunWatcher(watcher);

      expect(watcherRegistry.get('test-watcher')).toBeDefined();

      disposable.dispose();

      expect(watcherRegistry.get('test-watcher')).toBeUndefined();
    });
  });

  describe('registerPRWatcher', () => {
    it('delegates to prWatcherRegistry.register', () => {
      const watcher = {
        id: 'test-pr-watcher',
        label: 'Test PR Watcher',
        canWatch: vi.fn(),
        parsePRUrl: vi.fn(),
        getPRRunsSnapshot: vi.fn(),
      };
      const spy = vi.spyOn(prWatcherRegistry, 'register');

      api.registerPRWatcher(watcher);

      expect(spy).toHaveBeenCalledWith(watcher);
    });

    it('returns a Disposable that unregisters the watcher', () => {
      const watcher = {
        id: 'test-pr-watcher',
        label: 'Test PR Watcher',
        canWatch: vi.fn(),
        parsePRUrl: vi.fn(),
        getPRRunsSnapshot: vi.fn(),
      };
      const disposable = api.registerPRWatcher(watcher);

      expect(prWatcherRegistry.get('test-pr-watcher')).toBeDefined();

      disposable.dispose();

      expect(prWatcherRegistry.get('test-pr-watcher')).toBeUndefined();
    });
  });

  describe('addActivity', () => {
    it('delegates to workGraph.addActivity', async () => {
      const item = await workGraph.createItem({ title: 'Test' });
      const spy = vi.spyOn(workGraph, 'addActivity');

      await api.addActivity(item.id, 'action-executed', 'branch created');

      expect(spy).toHaveBeenCalledWith(item.id, 'action-executed', 'branch created');
    });

    it('appends an activity entry to the work item', async () => {
      const item = await workGraph.createItem({ title: 'Test' });

      await api.addActivity(item.id, 'action-executed', 'cleanup done');

      const updated = workGraph.getItem(item.id);
      expect(updated?.activityLog).toBeDefined();
      const actionEntries = updated!.activityLog!.filter(e => e.type === 'action-executed');
      expect(actionEntries).toHaveLength(1);
      expect(actionEntries[0].detail).toBe('cleanup done');
    });
  });
});

import { WorkCenterApiImpl } from '../api/workCenterApi';
import { WorkCenterProvider, WorkCenterAction, DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
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

function createMockProvider(id: string): WorkCenterProvider {
  const emitter = new vscode.EventEmitter<DiscoveredItem[]>();
  return {
    id,
    label: `Provider ${id}`,
    onDidDiscoverItems: emitter.event,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAction(id: string): WorkCenterAction {
  return {
    id,
    label: `Action ${id}`,
    canRun: vi.fn().mockReturnValue(true),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

// Contract tests for the public API surface that provider extensions consume.
// These intentionally overlap with registry-level tests to guard against
// accidental wiring changes in WorkCenterApiImpl.
describe('WorkCenterApiImpl', () => {
  let api: WorkCenterApiImpl;
  let providerRegistry: ProviderRegistry;
  let actionRegistry: ActionRegistry;

  beforeEach(() => {
    const stateStore = createMockStateStore();
    providerRegistry = new ProviderRegistry(stateStore);
    actionRegistry = new ActionRegistry();
    api = new WorkCenterApiImpl(providerRegistry, actionRegistry);
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
});

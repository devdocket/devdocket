import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockMemento } from 'vscode';
import { getViewLayout, toggleViewLayout, isProviderGroupNode, ProviderGroupNode, LayoutState, initViewLayoutStore, onDidChangeLayout, _resetViewLayoutStore } from '../views/viewLayout';

describe('viewLayout', () => {
  let memento: InstanceType<typeof MockMemento>;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetViewLayoutStore();
    memento = new MockMemento();
    await initViewLayoutStore(memento);
  });

  describe('getViewLayout', () => {
    it('returns default "tree" for inbox when no state set', () => {
      expect(getViewLayout('inbox')).toBe('tree');
    });

    it('returns default "flat" for queue when no state set', () => {
      expect(getViewLayout('queue')).toBe('flat');
    });

    it('returns default "flat" for focus when no state set', () => {
      expect(getViewLayout('focus')).toBe('flat');
    });

    it('returns default "flat" for history when no state set', () => {
      expect(getViewLayout('history')).toBe('flat');
    });

    it('returns default "tree" for sources when no state set', () => {
      expect(getViewLayout('sources')).toBe('tree');
    });

    it('returns stored value when set', async () => {
      await memento.update('devdocket.viewLayout', { inbox: 'flat' });
      expect(getViewLayout('inbox')).toBe('flat');
    });

    it('falls back to default for invalid values', async () => {
      await memento.update('devdocket.viewLayout', { inbox: 'invalid' });
      expect(getViewLayout('inbox')).toBe('tree');
    });
  });

  describe('toggleViewLayout', () => {
    it('toggles from tree to flat', async () => {
      await memento.update('devdocket.viewLayout', { inbox: 'tree' });

      await toggleViewLayout('inbox');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout');
      expect(stored?.inbox).toBe('flat');
    });

    it('toggles from flat to tree', async () => {
      await memento.update('devdocket.viewLayout', { queue: 'flat' });

      await toggleViewLayout('queue');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout');
      expect(stored?.queue).toBe('tree');
    });

    it('uses default when no state exists yet', async () => {
      // sources defaults to 'tree', so toggle should set to 'flat'
      await toggleViewLayout('sources');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout');
      expect(stored?.sources).toBe('flat');
    });

    it('fires onDidChangeLayout listener', async () => {
      const listener = vi.fn();
      onDidChangeLayout(listener);

      await toggleViewLayout('inbox');
      expect(listener).toHaveBeenCalledWith('inbox', 'flat');
    });

    it('stops firing after dispose', async () => {
      const listener = vi.fn();
      const sub = onDidChangeLayout(listener);
      sub.dispose();

      await toggleViewLayout('inbox');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('isProviderGroupNode', () => {
    it('returns true for valid ProviderGroupNode', () => {
      const node: ProviderGroupNode = { kind: 'providerGroup', label: 'test', providerId: 'gh' };
      expect(isProviderGroupNode(node)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isProviderGroupNode(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isProviderGroupNode(undefined)).toBe(false);
    });

    it('returns false for plain object without kind', () => {
      expect(isProviderGroupNode({ label: 'test' })).toBe(false);
    });

    it('returns false for object with wrong kind', () => {
      expect(isProviderGroupNode({ kind: 'item', label: 'test' })).toBe(false);
    });

    it('returns true for group node with undefined providerId', () => {
      const node: ProviderGroupNode = { kind: 'providerGroup', label: 'Other', providerId: undefined };
      expect(isProviderGroupNode(node)).toBe(true);
    });
  });

  describe('toggleViewLayout — edge cases', () => {
    it('preserves sibling view layouts when toggling one view', async () => {
      await memento.update('devdocket.viewLayout', { inbox: 'tree', queue: 'tree', focus: 'tree' });

      await toggleViewLayout('inbox');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout')!;
      expect(stored.inbox).toBe('flat');
      expect(stored.queue).toBe('tree');
      expect(stored.focus).toBe('tree');
    });

    it('strips invalid view IDs from stored state during toggle', async () => {
      await memento.update('devdocket.viewLayout', { inbox: 'tree', bogusView: 'flat' });

      await toggleViewLayout('inbox');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout')!;
      expect(stored.inbox).toBe('flat');
      expect(stored).not.toHaveProperty('bogusView');
    });

    it('strips invalid layout values from stored state during toggle', async () => {
      await memento.update('devdocket.viewLayout', { inbox: 'tree', focus: 'invalid' });

      await toggleViewLayout('inbox');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout')!;
      expect(stored.inbox).toBe('flat');
      expect(stored).not.toHaveProperty('focus');
    });

    it('persists to globalState', async () => {
      await memento.update('devdocket.viewLayout', { history: 'tree' });

      await toggleViewLayout('history');
      const stored = memento.get<Record<string, string>>('devdocket.viewLayout')!;
      expect(stored.history).toBe('flat');
    });
  });

  describe('LayoutState', () => {
    it('fires change callback on flat→tree transition', () => {
      const onChange = vi.fn();
      const state = new LayoutState('flat', onChange);

      state.value = 'tree';
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(state.value).toBe('tree');
    });

    it('fires change callback on tree→flat transition', () => {
      const onChange = vi.fn();
      const state = new LayoutState('tree', onChange);

      state.value = 'flat';
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(state.value).toBe('flat');
    });

    it('does not fire callback when set to same value', () => {
      const onChange = vi.fn();
      const state = new LayoutState('flat', onChange);

      state.value = 'flat';
      expect(onChange).not.toHaveBeenCalled();
    });

    it('initializes with the provided default layout', () => {
      const state = new LayoutState('tree', vi.fn());
      expect(state.value).toBe('tree');
    });

    it('fires callback on each actual transition', () => {
      const onChange = vi.fn();
      const state = new LayoutState('flat', onChange);

      state.value = 'tree';
      state.value = 'tree'; // no-op
      state.value = 'flat';
      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });
});

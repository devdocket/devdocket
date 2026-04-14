import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workspace, ConfigurationTarget, window } from 'vscode';
import { getViewLayout, toggleViewLayout, isProviderGroupNode, ProviderGroupNode, LayoutState } from '../views/viewLayout';

describe('viewLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getViewLayout', () => {
    it('returns default "tree" for inbox when no config set', () => {
      expect(getViewLayout('inbox')).toBe('tree');
    });

    it('returns default "flat" for queue when no config set', () => {
      expect(getViewLayout('queue')).toBe('flat');
    });

    it('returns default "flat" for focus when no config set', () => {
      expect(getViewLayout('focus')).toBe('flat');
    });

    it('returns default "flat" for history when no config set', () => {
      expect(getViewLayout('history')).toBe('flat');
    });

    it('returns default "tree" for sources when no config set', () => {
      expect(getViewLayout('sources')).toBe('tree');
    });

    it('returns configured value when set', () => {
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: any) => {
          if (_key === 'viewLayout') { return { inbox: 'flat' }; }
          return defaultValue;
        }),
      });
      expect(getViewLayout('inbox')).toBe('flat');
    });

    it('falls back to default for invalid values', () => {
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: any) => {
          if (_key === 'viewLayout') { return { inbox: 'invalid' }; }
          return defaultValue;
        }),
      });
      expect(getViewLayout('inbox')).toBe('tree');
    });
  });

  describe('toggleViewLayout', () => {
    it('toggles from tree to flat', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: any) => {
          if (_key === 'viewLayout') { return { inbox: 'tree' }; }
          return defaultValue;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => undefined),
      });

      await toggleViewLayout('inbox');
      expect(mockUpdate).toHaveBeenCalledWith(
        'viewLayout',
        expect.objectContaining({ inbox: 'flat' }),
        ConfigurationTarget.Global,
      );
    });

    it('toggles from flat to tree', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: any) => {
          if (_key === 'viewLayout') { return { queue: 'flat' }; }
          return defaultValue;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => undefined),
      });

      await toggleViewLayout('queue');
      expect(mockUpdate).toHaveBeenCalledWith(
        'viewLayout',
        expect.objectContaining({ queue: 'tree' }),
        ConfigurationTarget.Global,
      );
    });

    it('uses default when no config exists yet', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
        update: mockUpdate,
        inspect: vi.fn(() => undefined),
      });

      // sources defaults to 'tree', so toggle should set to 'flat'
      await toggleViewLayout('sources');
      expect(mockUpdate).toHaveBeenCalledWith(
        'viewLayout',
        expect.objectContaining({ sources: 'flat' }),
        ConfigurationTarget.Global,
      );
    });

    it('updates workspace scope when workspaceValue exists', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { focus: 'flat' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          workspaceValue: { focus: 'flat' },
        })),
      });

      await toggleViewLayout('focus');
      expect(mockUpdate).toHaveBeenCalledWith(
        'viewLayout',
        expect.objectContaining({ focus: 'tree' }),
        ConfigurationTarget.Workspace,
      );
    });

    it('prefers workspace scope even when workspaceFolder value exists', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { inbox: 'flat' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          workspaceValue: { inbox: 'flat' },
          workspaceFolderValue: { inbox: 'flat' },
        })),
      });

      await toggleViewLayout('inbox');
      expect(mockUpdate).toHaveBeenCalledWith(
        'viewLayout',
        expect.objectContaining({ inbox: 'tree' }),
        ConfigurationTarget.Workspace,
      );
    });

    it('shows warning when workspaceFolderValue overrides layout', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { queue: 'flat' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          workspaceFolderValue: { queue: 'flat' },
        })),
      });

      await toggleViewLayout('queue');
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('workspace-folder setting'),
      );
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
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { inbox: 'tree', queue: 'tree', focus: 'tree' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          globalValue: { inbox: 'tree', queue: 'tree', focus: 'tree' },
        })),
      });

      await toggleViewLayout('inbox');
      const persisted = mockUpdate.mock.calls[0][1];
      expect(persisted.inbox).toBe('flat');
      expect(persisted.queue).toBe('tree');
      expect(persisted.focus).toBe('tree');
    });

    it('strips invalid view IDs from stored config during toggle', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { inbox: 'tree', bogusView: 'flat' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          globalValue: { inbox: 'tree', bogusView: 'flat' },
        })),
      });

      await toggleViewLayout('inbox');
      const persisted = mockUpdate.mock.calls[0][1];
      expect(persisted.inbox).toBe('flat');
      expect(persisted).not.toHaveProperty('bogusView');
    });

    it('strips invalid layout values from stored config during toggle', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { inbox: 'tree', focus: 'invalid' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          globalValue: { inbox: 'tree', focus: 'invalid' },
        })),
      });

      await toggleViewLayout('inbox');
      const persisted = mockUpdate.mock.calls[0][1];
      expect(persisted.inbox).toBe('flat');
      expect(persisted).not.toHaveProperty('focus');
    });

    it('reads from globalValue scope when no workspaceValue exists', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string) => {
          if (_key === 'viewLayout') { return { history: 'tree' }; }
          return undefined;
        }),
        update: mockUpdate,
        inspect: vi.fn(() => ({
          globalValue: { history: 'tree' },
        })),
      });

      await toggleViewLayout('history');
      expect(mockUpdate).toHaveBeenCalledWith(
        'viewLayout',
        expect.objectContaining({ history: 'flat' }),
        ConfigurationTarget.Global,
      );
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

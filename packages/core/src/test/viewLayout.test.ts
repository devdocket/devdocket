import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workspace, ConfigurationTarget } from 'vscode';
import { getViewLayout, toggleViewLayout, isProviderGroupNode, ProviderGroupNode } from '../views/viewLayout';

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
});

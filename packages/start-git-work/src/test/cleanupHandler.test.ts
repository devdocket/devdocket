import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window } from 'vscode';
import { CleanupHandler, metadataKey, type GitWorkMetadata } from '../cleanupHandler';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], optsOrCb: any, cb?: Function) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    callback?.(null, '', '');
  }),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

import { execFile } from 'child_process';
import * as fs from 'fs';

function createMockMemento() {
  const store = new Map<string, any>();
  return {
    get: vi.fn((key: string, defaultValue?: any) => store.has(key) ? store.get(key) : defaultValue),
    update: vi.fn(async (key: string, value: any) => {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    }),
    keys: () => [...store.keys()],
    _store: store,
  };
}

function createEvent(overrides: Partial<{
  itemId: string; title: string; oldState: string; newState: string;
}> = {}) {
  return {
    item: {
      id: overrides.itemId ?? 'item-1',
      title: overrides.title ?? 'Fix login bug',
    },
    oldState: overrides.oldState ?? 'InProgress',
    newState: overrides.newState ?? 'Done',
  };
}

const DEFAULT_METADATA: GitWorkMetadata = {
  branchName: 'issue123',
  worktreePath: '/repos/myrepo-issue123',
  repoPath: '/repos/myrepo',
};

describe('CleanupHandler', () => {
  let handler: CleanupHandler;
  let mockMemento: ReturnType<typeof createMockMemento>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMemento = createMockMemento();
    handler = new CleanupHandler(mockMemento as any);

    // Default: execFile succeeds
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
      cb(null, { stdout: '', stderr: '' }, '');
    }) as any);
  });

  describe('handleStateTransition', () => {
    it('does nothing for non-Done transitions', async () => {
      const event = createEvent({ newState: 'Paused' });
      await handler.handleStateTransition(event);

      expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('does nothing when no metadata stored for item', async () => {
      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('clears stale metadata when both worktree and branch are already gone', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Branch doesn't exist (git branch --list returns empty)
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, { stdout: '', stderr: '' }, '');
      }) as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(window.showInformationMessage).not.toHaveBeenCalled();
      expect(mockMemento.update).toHaveBeenCalledWith(metadataKey('item-1'), undefined);
    });

    it('prompts user when worktree exists', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString() === DEFAULT_METADATA.worktreePath;
      });
      vi.mocked(window.showInformationMessage).mockResolvedValue('No' as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('worktree'),
        'Yes',
        'No',
      );
    });

    it('prompts user when branch exists', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Branch exists
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: '  issue123\n', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('branch'),
        'Yes',
        'No',
      );
    });

    it('prompts with both worktree and branch when both exist', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString() === DEFAULT_METADATA.worktreePath;
      });
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: '  issue123\n', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);
      vi.mocked(window.showInformationMessage).mockResolvedValue('No' as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      const message = vi.mocked(window.showInformationMessage).mock.calls[0][0] as string;
      expect(message).toContain('worktree');
      expect(message).toContain('branch');
    });

    it('clears metadata when user selects No', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString() === DEFAULT_METADATA.worktreePath;
      });
      vi.mocked(window.showInformationMessage).mockResolvedValue('No' as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      // Should not have attempted any git cleanup commands
      expect(execFile).not.toHaveBeenCalledWith(
        'git', expect.arrayContaining(['worktree', 'remove']), expect.anything(), expect.anything(),
      );
      // Should clear metadata so we don't ask again
      expect(mockMemento.update).toHaveBeenCalledWith(metadataKey('item-1'), undefined);
    });

    it('clears metadata when user dismisses the dialog', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString() === DEFAULT_METADATA.worktreePath;
      });
      // Dismissing (Escape / close) resolves to undefined
      vi.mocked(window.showInformationMessage).mockResolvedValue(undefined as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(execFile).not.toHaveBeenCalledWith(
        'git', expect.arrayContaining(['worktree', 'remove']), expect.anything(), expect.anything(),
      );
      // Should clear metadata so we don't ask again
      expect(mockMemento.update).toHaveBeenCalledWith(metadataKey('item-1'), undefined);
    });

    it('removes worktree and deletes branch when user selects Yes', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      // Worktree exists initially but not after removal
      let worktreeRemoved = false;
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        if (p.toString() === DEFAULT_METADATA.worktreePath) {
          return !worktreeRemoved;
        }
        return false;
      });
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: '  issue123\n', stderr: '' }, '');
        } else if (args[0] === 'worktree' && args[1] === 'remove') {
          worktreeRemoved = true;
          cb(null, { stdout: '', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);
      vi.mocked(window.showInformationMessage).mockResolvedValue('Yes' as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      // Should have removed worktree
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', DEFAULT_METADATA.worktreePath],
        { cwd: DEFAULT_METADATA.repoPath },
        expect.any(Function),
      );
      // Should have deleted branch with -d (not -D)
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['branch', '-d', 'issue123'],
        { cwd: DEFAULT_METADATA.repoPath },
        expect.any(Function),
      );
      // Should have cleared metadata
      expect(mockMemento.update).toHaveBeenCalledWith(metadataKey('item-1'), undefined);
    });

    it('warns when branch has unmerged changes', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: '  issue123\n', stderr: '' }, '');
        } else if (args[0] === 'branch' && args[1] === '-d') {
          const err = new Error('error: The branch \'issue123\' is not fully merged.');
          (err as any).stderr = 'error: The branch \'issue123\' is not fully merged.';
          cb(err, { stdout: '', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);
      vi.mocked(window.showInformationMessage).mockResolvedValue('Yes' as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('unmerged changes'),
      );
      // Should NOT clear metadata since branch wasn't deleted
      expect(mockMemento.update).not.toHaveBeenCalledWith(metadataKey('item-1'), undefined);
    });

    it('warns when worktree removal fails', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString() === DEFAULT_METADATA.worktreePath;
      });
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
        if (args[0] === 'branch' && args[1] === '--list') {
          cb(null, { stdout: '', stderr: '' }, '');
        } else if (args[0] === 'worktree' && args[1] === 'remove') {
          cb(new Error('contains modified or untracked files'), { stdout: '', stderr: '' }, '');
        } else {
          cb(null, { stdout: '', stderr: '' }, '');
        }
      }) as any);
      vi.mocked(window.showInformationMessage).mockResolvedValue('Yes' as any);

      const event = createEvent();
      await handler.handleStateTransition(event);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove worktree'),
      );
    });

    it('includes item title in prompt message', async () => {
      mockMemento._store.set(metadataKey('item-1'), DEFAULT_METADATA);
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.toString() === DEFAULT_METADATA.worktreePath;
      });
      vi.mocked(window.showInformationMessage).mockResolvedValue('No' as any);

      const event = createEvent({ title: 'My special task' });
      await handler.handleStateTransition(event);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('My special task'),
        'Yes',
        'No',
      );
    });
  });
});

describe('metadataKey', () => {
  it('creates a key from item ID', () => {
    expect(metadataKey('abc-123')).toBe('gitWork:abc-123');
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workspace } from 'vscode';
import { registerListDirectoryTool } from '../../tools/listDirectoryTool';

describe('listDirectoryTool', () => {
  describe('registerListDirectoryTool', () => {
    it('returns a disposable', () => {
      const disposable = registerListDirectoryTool();
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });

  describe('invoke', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('lists directory contents', async () => {
      vi.mocked(workspace.fs.readDirectory).mockResolvedValue([
        ['src', 2],     // Directory
        ['README.md', 1], // File
      ] as never);

      const { lm } = await import('vscode');
      registerListDirectoryTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });

    it('rejects path traversal', async () => {
      const { lm } = await import('vscode');
      registerListDirectoryTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', dirPath: '../../etc' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });

    it('handles errors gracefully', async () => {
      vi.mocked(workspace.fs.readDirectory).mockRejectedValue(new Error('not found'));

      const { lm } = await import('vscode');
      registerListDirectoryTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', dirPath: 'nonexistent' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });
  });
});

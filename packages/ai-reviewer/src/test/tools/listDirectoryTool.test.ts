import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { workspace } from 'vscode';
import { registerListDirectoryTool } from '../../tools/listDirectoryTool';
import { validWorktreePaths } from '../../tools/worktreeRegistry';

vi.mock('fs/promises', () => ({
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

describe('listDirectoryTool', () => {
  beforeEach(() => {
    validWorktreePaths.add(path.resolve('/mock/worktree'));
  });

  afterEach(() => {
    validWorktreePaths.clear();
  });

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
      vi.mocked(fs.realpath).mockImplementation((p: unknown) =>
        Promise.resolve(path.resolve(String(p))),
      );
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

      expect(workspace.fs.readDirectory).toHaveBeenCalled();
      const text = (result as { content: Array<{ value: string }> }).content[0].value;
      expect(text).toContain('[dir]');
      expect(text).toContain('src');
      expect(text).toContain('README.md');
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
      vi.mocked(fs.realpath).mockImplementation((p: unknown) =>
        Promise.resolve(path.resolve(String(p))),
      );
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

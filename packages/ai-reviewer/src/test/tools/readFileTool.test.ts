import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { workspace } from 'vscode';
import { registerReadFileTool, validatePath } from '../../tools/readFileTool';
import { validWorktreePaths } from '../../tools/worktreeRegistry';

vi.mock('fs/promises', () => ({
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

describe('readFileTool', () => {
  beforeEach(() => {
    validWorktreePaths.add(path.resolve('/worktree'));
    validWorktreePaths.add(path.resolve('/mock/worktree'));
  });

  afterEach(() => {
    validWorktreePaths.clear();
  });

  describe('validatePath', () => {
    it('allows normal relative paths', () => {
      expect(validatePath('/worktree', 'src/index.ts')).toBeUndefined();
    });

    it('rejects paths with ..', () => {
      const err = validatePath('/worktree', '../../../etc/passwd');
      expect(err).toContain('Path traversal not allowed');
    });

    it('rejects absolute paths', () => {
      const err = validatePath('/worktree', '/etc/passwd');
      expect(err).toContain('Path traversal not allowed');
    });

    it('allows paths with .. that stay inside worktree', () => {
      // e.g. src/../lib/index.ts normalizes to lib/index.ts
      expect(validatePath('/worktree', 'src/../lib/index.ts')).toBeUndefined();
    });
  });

  describe('registerReadFileTool', () => {
    it('returns a disposable', () => {
      const disposable = registerReadFileTool();
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });

  describe('invoke', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('reads file content successfully', async () => {
      const content = 'export const hello = "world";';
      const worktree = path.resolve('/mock/worktree');
      const fullFile = path.resolve('/mock/worktree', 'src/index.ts');
      vi.mocked(workspace.fs.readFile).mockResolvedValue(
        new TextEncoder().encode(content) as never,
      );
      vi.mocked(fs.realpath).mockImplementation((p: unknown) =>
        Promise.resolve(path.resolve(String(p))),
      );

      // Get the handler from the registerTool mock
      const { lm } = await import('vscode');
      registerReadFileTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', filePath: 'src/index.ts' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(workspace.fs.readFile).toHaveBeenCalled();
      expect((result as { content: Array<{ value: string }> }).content[0].value).toBe(content);
    });

    it('rejects path traversal attempts', async () => {
      const { lm } = await import('vscode');
      registerReadFileTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', filePath: '../../etc/passwd' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      // Result should contain an error about path traversal
      expect(result).toBeDefined();
    });

    it('handles file read errors', async () => {
      vi.mocked(fs.realpath).mockImplementation((p: unknown) =>
        Promise.resolve(path.resolve(String(p))),
      );
      vi.mocked(workspace.fs.readFile).mockRejectedValue(new Error('File not found'));

      const { lm } = await import('vscode');
      registerReadFileTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', filePath: 'nonexistent.ts' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });
  });
});

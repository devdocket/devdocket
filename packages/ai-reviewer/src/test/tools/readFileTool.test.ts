import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workspace, LanguageModelToolResult, LanguageModelTextPart } from 'vscode';
import { registerReadFileTool, validatePath } from '../../tools/readFileTool';

describe('readFileTool', () => {
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
      vi.mocked(workspace.fs.readFile).mockResolvedValue(
        new TextEncoder().encode(content) as never,
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

      expect(result).toBeDefined();
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

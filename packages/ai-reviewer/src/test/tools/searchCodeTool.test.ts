import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerSearchCodeTool } from '../../tools/searchCodeTool';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, 'src/index.ts:1:export const hello = "world";', '');
  }),
}));

import { execFile } from 'child_process';

describe('searchCodeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerSearchCodeTool', () => {
    it('returns a disposable', () => {
      const disposable = registerSearchCodeTool();
      expect(disposable).toBeDefined();
    });
  });

  describe('invoke', () => {
    it('runs git grep with pattern', async () => {
      const { lm } = await import('vscode');
      registerSearchCodeTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', pattern: 'hello' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['grep', '-n', '--no-color', 'hello']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('runs git grep with fileGlob', async () => {
      const { lm } = await import('vscode');
      registerSearchCodeTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', pattern: 'hello', fileGlob: '*.ts' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['--', '*.ts']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('truncates output exceeding maxResults', async () => {
      const manyLines = Array.from({ length: 100 }, (_, i) => `file.ts:${i}:match`).join('\n');
      vi.mocked(execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          (cb as Function)(null, manyLines, '');
          return undefined as never;
        },
      );

      const { lm } = await import('vscode');
      registerSearchCodeTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', pattern: 'match', maxResults: 10 },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });

    it('handles no matches (exit code 1)', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          const err = new Error('git grep failed') as NodeJS.ErrnoException;
          err.code = '1';
          (cb as Function)(err, '', '');
          return undefined as never;
        },
      );

      const { lm } = await import('vscode');
      registerSearchCodeTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', pattern: 'nonexistent' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });
  });
});

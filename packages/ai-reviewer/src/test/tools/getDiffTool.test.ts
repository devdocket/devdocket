import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { registerGetDiffTool } from '../../tools/getDiffTool';
import { validWorktreePaths } from '../../tools/worktreeRegistry';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, 'diff --git a/file.ts b/file.ts\n+added line', '');
  }),
}));

import { execFile } from 'child_process';

describe('getDiffTool', () => {
  beforeEach(() => {
    validWorktreePaths.add(path.resolve('/mock/worktree'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    validWorktreePaths.clear();
  });

  describe('registerGetDiffTool', () => {
    it('returns a disposable', () => {
      const disposable = registerGetDiffTool();
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });

  describe('invoke', () => {
    it('runs correct git diff command', async () => {
      const { lm } = await import('vscode');
      registerGetDiffTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', baseRef: 'origin/main', headRef: 'pr-42' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['diff', '--no-color', 'origin/main...pr-42']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('handles git errors gracefully', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          (cb as Function)(new Error('git diff failed'), '', 'fatal error');
          return undefined as never;
        },
      );

      const { lm } = await import('vscode');
      registerGetDiffTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', baseRef: 'origin/main', headRef: 'pr-42' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(result).toBeDefined();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { registerGetFileDiffTool } from '../../tools/getFileDiffTool';
import { validWorktreePaths } from '../../tools/worktreeRegistry';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, 'diff --git a/src/index.ts b/src/index.ts\n+added', '');
  }),
}));

import { execFile } from 'child_process';

describe('getFileDiffTool', () => {
  beforeEach(() => {
    validWorktreePaths.add(path.resolve('/mock/worktree'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    validWorktreePaths.clear();
  });

  describe('registerGetFileDiffTool', () => {
    it('returns a disposable', () => {
      const disposable = registerGetFileDiffTool();
      expect(disposable).toBeDefined();
    });
  });

  describe('invoke', () => {
    it('runs correct git diff with file path', async () => {
      const { lm } = await import('vscode');
      registerGetFileDiffTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: {
            worktreePath: '/mock/worktree',
            baseRef: 'origin/main',
            headRef: 'pr-42',
            filePath: 'src/index.ts',
          },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['diff', '--no-color', 'origin/main...pr-42', '--', 'src/index.ts']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('rejects path traversal in filePath', async () => {
      const { lm } = await import('vscode');
      registerGetFileDiffTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: {
            worktreePath: '/mock/worktree',
            baseRef: 'origin/main',
            headRef: 'pr-42',
            filePath: '../../etc/passwd',
          },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      // Should not have called git
      expect(execFile).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });
});

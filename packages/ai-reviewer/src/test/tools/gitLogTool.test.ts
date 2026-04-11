import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { registerGitLogTool } from '../../tools/gitLogTool';
import { validWorktreePaths } from '../../tools/worktreeRegistry';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, 'abc1234 Initial commit\ndef5678 Second commit', '');
  }),
}));

import { execFile } from 'child_process';

describe('gitLogTool', () => {
  beforeEach(() => {
    validWorktreePaths.add(path.resolve('/mock/worktree'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    validWorktreePaths.clear();
  });

  describe('registerGitLogTool', () => {
    it('returns a disposable', () => {
      const disposable = registerGitLogTool();
      expect(disposable).toBeDefined();
    });
  });

  describe('invoke', () => {
    it('runs git log with default maxCount', async () => {
      const { lm } = await import('vscode');
      registerGitLogTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['log', '--oneline', '-n', '20']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('runs git log with custom maxCount', async () => {
      const { lm } = await import('vscode');
      registerGitLogTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', maxCount: 5 },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-n', '5']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('runs git log with filePath', async () => {
      const { lm } = await import('vscode');
      registerGitLogTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', filePath: 'src/index.ts' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['--', 'src/index.ts']),
        expect.objectContaining({ cwd: '/mock/worktree' }),
        expect.any(Function),
      );
    });

    it('rejects path traversal in filePath', async () => {
      const { lm } = await import('vscode');
      registerGitLogTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { worktreePath: '/mock/worktree', filePath: '../../etc/passwd' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      expect(execFile).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });
});

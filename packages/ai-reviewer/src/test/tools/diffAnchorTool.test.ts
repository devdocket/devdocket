import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import { registerDiffAnchorTool } from '../../tools/diffAnchorTool';

describe('diffAnchorTool', () => {
  describe('registerDiffAnchorTool', () => {
    it('returns a disposable', () => {
      const disposable = registerDiffAnchorTool();
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });

  describe('invoke', () => {
    it('returns correct SHA-256 hex digest for a file path', async () => {
      const { lm } = await import('vscode');
      registerDiffAnchorTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { filePath: 'src/index.ts' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      const expected = crypto.createHash('sha256').update('src/index.ts', 'utf8').digest('hex');
      expect(result).toBeDefined();

      // Extract text from the result
      const content = (result as unknown as { content: Array<{ value: string }> }).content;
      expect(content).toHaveLength(1);
      expect(content[0].value).toBe(expected);
    });

    it('returns error for missing filePath', async () => {
      const { lm } = await import('vscode');
      registerDiffAnchorTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const result = await handler.invoke(
        {
          input: { filePath: '' },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      const content = (result as unknown as { content: Array<{ value: string }> }).content;
      expect(content[0].value).toContain('Error');
    });

    it('produces consistent hashes matching Node crypto', async () => {
      const { lm } = await import('vscode');
      registerDiffAnchorTool();
      const handler = vi.mocked(lm.registerTool).mock.calls[0][1];

      const filePath = 'packages/core/src/models/workItem.ts';
      const result = await handler.invoke(
        {
          input: { filePath },
          toolInvocationToken: undefined,
        } as never,
        { isCancellationRequested: false } as never,
      );

      const expected = crypto.createHash('sha256').update(filePath, 'utf8').digest('hex');
      const content = (result as unknown as { content: Array<{ value: string }> }).content;
      expect(content[0].value).toBe(expected);
    });
  });
});

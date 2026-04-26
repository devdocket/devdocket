import { describe, it, expect } from 'vitest';
import { fenceDiff } from '../diffFence';

describe('fenceDiff', () => {
  it('wraps simple content with 4-backtick fence', () => {
    const result = fenceDiff('+added line');
    expect(result).toBe('````diff\n+added line\n````');
  });

  it('uses a longer fence when content contains 4 backticks', () => {
    const content = 'some code\n````\nmore code';
    const result = fenceDiff(content);
    // Fence must be longer than the 4-backtick run in content
    expect(result).toMatch(/^`{5,}diff\n/);
    expect(result).toMatch(/\n`{5,}$/);
  });

  it('uses a longer fence when content contains many backticks', () => {
    const content = 'prefix\n``````\nsuffix';
    const result = fenceDiff(content);
    // Content has 6 backticks, fence must be >= 7
    expect(result).toMatch(/^`{7,}diff\n/);
    expect(result).toMatch(/\n`{7,}$/);
  });

  it('handles content with no backticks', () => {
    const result = fenceDiff('plain diff');
    expect(result).toBe('````diff\nplain diff\n````');
  });

  it('handles empty content', () => {
    const result = fenceDiff('');
    expect(result).toBe('````diff\n\n````');
  });

  it('handles content where backticks appear at the end', () => {
    const content = 'code````';
    const result = fenceDiff(content);
    expect(result).toMatch(/^`{5,}diff\n/);
  });

  it('opening and closing fences match', () => {
    const content = 'some\n`````\ncontent';
    const result = fenceDiff(content);
    const lines = result.split('\n');
    const openFence = lines[0].replace('diff', '');
    const closeFence = lines[lines.length - 1];
    expect(openFence).toBe(closeFence);
  });
});

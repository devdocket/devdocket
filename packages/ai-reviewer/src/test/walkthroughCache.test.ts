import { describe, it, expect } from 'vitest';
import { WalkthroughCache } from '../walkthroughCache';

describe('WalkthroughCache', () => {
  it('returns undefined for unknown PR URLs', () => {
    const cache = new WalkthroughCache();
    expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBeUndefined();
  });

  it('stores and retrieves findings by PR URL', () => {
    const cache = new WalkthroughCache();
    cache.setFindings('https://github.com/owner/repo/pull/42', 'Some findings');
    expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBe('Some findings');
  });

  it('replaces findings when setFindings is called again', () => {
    const cache = new WalkthroughCache();
    cache.setFindings('https://github.com/owner/repo/pull/42', 'First');
    cache.setFindings('https://github.com/owner/repo/pull/42', 'Second');
    expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBe('Second');
  });

  it('appends to existing findings', () => {
    const cache = new WalkthroughCache();
    cache.appendFindings('https://github.com/owner/repo/pull/42', 'Part 1');
    cache.appendFindings('https://github.com/owner/repo/pull/42', ' Part 2');
    expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBe('Part 1 Part 2');
  });

  it('creates new entry when appending to non-existent key', () => {
    const cache = new WalkthroughCache();
    cache.appendFindings('https://github.com/owner/repo/pull/99', 'New');
    expect(cache.getFindings('https://github.com/owner/repo/pull/99')).toBe('New');
  });

  it('reports hasFindings correctly', () => {
    const cache = new WalkthroughCache();
    expect(cache.hasFindings('https://github.com/owner/repo/pull/42')).toBe(false);
    cache.setFindings('https://github.com/owner/repo/pull/42', 'content');
    expect(cache.hasFindings('https://github.com/owner/repo/pull/42')).toBe(true);
  });

  it('clears findings for a specific PR', () => {
    const cache = new WalkthroughCache();
    cache.setFindings('https://github.com/owner/repo/pull/42', 'content');
    cache.setFindings('https://github.com/owner/repo/pull/99', 'other');
    cache.clearFindings('https://github.com/owner/repo/pull/42');
    expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBeUndefined();
    expect(cache.getFindings('https://github.com/owner/repo/pull/99')).toBe('other');
  });

  it('isolates findings by PR URL', () => {
    const cache = new WalkthroughCache();
    cache.setFindings('https://github.com/owner/repo/pull/1', 'PR 1');
    cache.setFindings('https://github.com/owner/repo/pull/2', 'PR 2');
    expect(cache.getFindings('https://github.com/owner/repo/pull/1')).toBe('PR 1');
    expect(cache.getFindings('https://github.com/owner/repo/pull/2')).toBe('PR 2');
  });
});

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

  it('evicts oldest entries when exceeding max cache size', () => {
    const cache = new WalkthroughCache();
    // Fill to capacity (20 entries)
    for (let i = 1; i <= 20; i++) {
      cache.setFindings(`https://github.com/owner/repo/pull/${i}`, `PR ${i}`);
    }
    expect(cache.size).toBe(20);

    // Adding one more evicts the oldest (PR 1)
    cache.setFindings('https://github.com/owner/repo/pull/21', 'PR 21');
    expect(cache.size).toBe(20);
    expect(cache.getFindings('https://github.com/owner/repo/pull/1')).toBeUndefined();
    expect(cache.getFindings('https://github.com/owner/repo/pull/2')).toBe('PR 2');
    expect(cache.getFindings('https://github.com/owner/repo/pull/21')).toBe('PR 21');
  });

  it('refreshes insertion order when updating existing entries', () => {
    const cache = new WalkthroughCache();
    for (let i = 1; i <= 20; i++) {
      cache.setFindings(`https://github.com/owner/repo/pull/${i}`, `PR ${i}`);
    }

    // Touch PR 1 to move it to the end
    cache.setFindings('https://github.com/owner/repo/pull/1', 'PR 1 updated');

    // Add new entry — should evict PR 2 (now the oldest), not PR 1
    cache.setFindings('https://github.com/owner/repo/pull/21', 'PR 21');
    expect(cache.getFindings('https://github.com/owner/repo/pull/1')).toBe('PR 1 updated');
    expect(cache.getFindings('https://github.com/owner/repo/pull/2')).toBeUndefined();
  });

  describe('URL normalization', () => {
    it('matches URLs with query strings to clean URLs', () => {
      const cache = new WalkthroughCache();
      cache.setFindings('https://github.com/owner/repo/pull/42', 'findings');
      expect(cache.getFindings('https://github.com/owner/repo/pull/42?diff=unified')).toBe('findings');
    });

    it('matches URLs with fragments to clean URLs', () => {
      const cache = new WalkthroughCache();
      cache.setFindings('https://github.com/owner/repo/pull/42', 'findings');
      expect(cache.getFindings('https://github.com/owner/repo/pull/42#discussion_r123')).toBe('findings');
    });

    it('matches URLs with extra path segments to clean URLs', () => {
      const cache = new WalkthroughCache();
      cache.setFindings('https://github.com/owner/repo/pull/42', 'findings');
      expect(cache.getFindings('https://github.com/owner/repo/pull/42/files')).toBe('findings');
    });

    it('appends to normalized key even when URL variants differ', () => {
      const cache = new WalkthroughCache();
      cache.appendFindings('https://github.com/owner/repo/pull/42', 'Part 1');
      cache.appendFindings('https://github.com/owner/repo/pull/42?w=1', ' Part 2');
      expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBe('Part 1 Part 2');
    });

    it('handles non-GitHub URLs gracefully', () => {
      const cache = new WalkthroughCache();
      cache.setFindings('https://example.com/some/path', 'data');
      expect(cache.getFindings('https://example.com/some/path')).toBe('data');
    });

    it('handles invalid URLs gracefully', () => {
      const cache = new WalkthroughCache();
      cache.setFindings('not-a-url', 'data');
      expect(cache.getFindings('not-a-url')).toBe('data');
    });

    it('normalizes case-insensitive owner/repo in GitHub URLs', () => {
      const cache = new WalkthroughCache();
      cache.setFindings('https://github.com/Owner/Repo/pull/42', 'findings');
      expect(cache.getFindings('https://github.com/owner/repo/pull/42')).toBe('findings');
      expect(cache.getFindings('https://github.com/OWNER/REPO/pull/42')).toBe('findings');
    });
  });
});

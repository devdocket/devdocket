import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseRepoFromUrls } from '../parseRepo';
import { initLogger, LogLevel } from '../logger';

describe('parseRepoFromUrls', () => {
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);
  });

  it('extracts owner/repo from valid github.com html_url', () => {
    const result = parseRepoFromUrls(
      'https://github.com/owner/repo/issues/42',
      'https://api.github.com/repos/owner/repo',
    );
    expect(result).toBe('owner/repo');
  });

  it('extracts owner/repo from valid github.com pull URL', () => {
    const result = parseRepoFromUrls(
      'https://github.com/org/project/pull/7',
      'https://api.github.com/repos/org/project',
    );
    expect(result).toBe('org/project');
  });

  it('rejects html_url from unexpected domain and falls back to repository_url', () => {
    const result = parseRepoFromUrls(
      'https://evil.com/github.com/attacker/repo/issues/1',
      'https://api.github.com/repos/legit/repo',
    );
    expect(result).toBe('legit/repo');
  });

  it('returns hash fallback when both URLs are from unexpected domains', () => {
    const result = parseRepoFromUrls(
      'https://evil.com/github.com/attacker/repo/issues/1',
      'https://evil.com/repos/attacker/repo',
    );
    expect(result).toMatch(/^unknown-repo-[0-9a-f]{12}$/);
  });

  it('produces deterministic hash for same repository_url', () => {
    const result1 = parseRepoFromUrls('https://evil.com/x', 'https://evil.com/repos/a/b');
    const result2 = parseRepoFromUrls('https://evil.com/y', 'https://evil.com/repos/a/b');
    expect(result1).toBe(result2);
  });

  it('produces different hashes for different repository_urls', () => {
    const result1 = parseRepoFromUrls('https://evil.com/x', 'https://evil.com/repos/a/b');
    const result2 = parseRepoFromUrls('https://evil.com/x', 'https://evil.com/repos/c/d');
    expect(result1).not.toBe(result2);
  });

  it('rejects http:// (non-TLS) github.com URLs', () => {
    const result = parseRepoFromUrls(
      'http://github.com/owner/repo/issues/1',
      'https://evil.com/repos/owner/repo',
    );
    expect(result).toMatch(/^unknown-repo-[0-9a-f]{12}$/);
  });

  it('logs warning when falling back to hash', () => {
    parseRepoFromUrls(
      'https://evil.com/issues/1',
      'https://evil.com/repos/a/b',
    );
    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('[WARN]') && call[0].includes('Could not parse repo'),
    );
    expect(logged).toBe(true);
  });

  it('rejects html_url with control characters in path segments', () => {
    const result = parseRepoFromUrls(
      'https://github.com/owner%0a/repo/issues/1',
      'https://api.github.com/repos/owner/repo',
    );
    expect(result).toBe('owner/repo');
  });

  it('rejects repository_url with whitespace in path segments', () => {
    const result = parseRepoFromUrls(
      'https://evil.com/x',
      'https://api.github.com/repos/owner/repo name',
    );
    expect(result).toMatch(/^unknown-repo-/);
  });

  it('handles percent-encoded valid characters in path segments', () => {
    const result = parseRepoFromUrls(
      'https://github.com/my%2Dorg/my%2Drepo/issues/1',
      'https://api.github.com/repos/my%2Dorg/my%2Drepo',
    );
    expect(result).toBe('my-org/my-repo');
  });

  it('handles completely invalid URL gracefully', () => {
    const result = parseRepoFromUrls(
      'not-a-url',
      'also-not-a-url',
    );
    expect(result).toMatch(/^unknown-repo-/);
  });
});

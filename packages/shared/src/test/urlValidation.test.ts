import { describe, it, expect } from 'vitest';
import { isValidRepoSlug, sanitizeUrlSegment } from '../urlValidation';

// ---------------------------------------------------------------------------
// isValidRepoSlug
// ---------------------------------------------------------------------------
describe('isValidRepoSlug', () => {
  // --- valid slugs ---
  it('accepts a simple owner/repo slug', () => {
    expect(isValidRepoSlug('owner/repo')).toBe(true);
  });

  it('accepts hyphens in owner and repo', () => {
    expect(isValidRepoSlug('my-org/my-repo')).toBe(true);
  });

  it('accepts underscores in owner and repo', () => {
    expect(isValidRepoSlug('my_org/my_repo')).toBe(true);
  });

  it('accepts dots in owner and repo', () => {
    expect(isValidRepoSlug('my.org/my.repo')).toBe(true);
  });

  it('accepts numeric names', () => {
    expect(isValidRepoSlug('123/456')).toBe(true);
  });

  it('accepts mixed alphanumeric, hyphens, underscores, and dots', () => {
    expect(isValidRepoSlug('a-b_c.d/e-f_g.h')).toBe(true);
  });

  it('accepts single-character owner and repo', () => {
    expect(isValidRepoSlug('a/b')).toBe(true);
  });

  // --- empty / missing values ---
  it('rejects an empty string', () => {
    expect(isValidRepoSlug('')).toBe(false);
  });

  it('rejects a bare slash', () => {
    expect(isValidRepoSlug('/')).toBe(false);
  });

  it('rejects a slug with an empty owner', () => {
    expect(isValidRepoSlug('/repo')).toBe(false);
  });

  it('rejects a slug with an empty repo', () => {
    expect(isValidRepoSlug('owner/')).toBe(false);
  });

  // --- path traversal ---
  it('rejects path traversal (../) in owner', () => {
    expect(isValidRepoSlug('../evil/repo')).toBe(false);
  });

  it('rejects path traversal in repo segment', () => {
    expect(isValidRepoSlug('owner/../etc')).toBe(false);
  });

  it('accepts single dot as a valid segment character', () => {
    // A lone dot is a valid character, so `./repo` is `owner=".", repo="repo"`
    expect(isValidRepoSlug('./repo')).toBe(true);
  });

  // --- extra slashes ---
  it('rejects slugs with multiple slashes', () => {
    expect(isValidRepoSlug('a/b/c')).toBe(false);
  });

  it('rejects slugs without any slash', () => {
    expect(isValidRepoSlug('noslash')).toBe(false);
  });

  // --- query params and fragments ---
  it('rejects query parameters', () => {
    expect(isValidRepoSlug('owner/repo?ref=main')).toBe(false);
  });

  it('rejects fragment identifiers', () => {
    expect(isValidRepoSlug('owner/repo#readme')).toBe(false);
  });

  // --- backslashes ---
  it('rejects backslashes', () => {
    expect(isValidRepoSlug('owner\\repo')).toBe(false);
  });

  it('rejects mixed slash and backslash', () => {
    expect(isValidRepoSlug('owner/repo\\sub')).toBe(false);
  });

  // --- unicode ---
  it('rejects unicode characters in owner', () => {
    expect(isValidRepoSlug('ownér/repo')).toBe(false);
  });

  it('rejects unicode characters in repo', () => {
    expect(isValidRepoSlug('owner/repö')).toBe(false);
  });

  it('rejects emoji in slug', () => {
    expect(isValidRepoSlug('owner/repo🚀')).toBe(false);
  });

  // --- very long strings ---
  it('accepts a long but valid slug', () => {
    const owner = 'a'.repeat(200);
    const repo = 'b'.repeat(200);
    expect(isValidRepoSlug(`${owner}/${repo}`)).toBe(true);
  });

  it('rejects a very long string with no slash', () => {
    expect(isValidRepoSlug('x'.repeat(1000))).toBe(false);
  });

  // --- special characters ---
  it('rejects spaces', () => {
    expect(isValidRepoSlug('owner/ repo')).toBe(false);
  });

  it('rejects at-signs', () => {
    expect(isValidRepoSlug('@owner/repo')).toBe(false);
  });

  it('rejects colons', () => {
    expect(isValidRepoSlug('owner:repo/name')).toBe(false);
  });

  it('rejects exclamation marks', () => {
    expect(isValidRepoSlug('owner/repo!')).toBe(false);
  });

  it('rejects semicolons', () => {
    expect(isValidRepoSlug('owner/repo;drop')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeUrlSegment
// ---------------------------------------------------------------------------
describe('sanitizeUrlSegment', () => {
  it('keeps alphanumeric characters', () => {
    expect(sanitizeUrlSegment('abc123')).toBe('abc123');
  });

  it('keeps hyphens', () => {
    expect(sanitizeUrlSegment('my-repo')).toBe('my-repo');
  });

  it('keeps underscores', () => {
    expect(sanitizeUrlSegment('my_repo')).toBe('my_repo');
  });

  it('keeps dots', () => {
    expect(sanitizeUrlSegment('v1.0.0')).toBe('v1.0.0');
  });

  it('keeps tildes', () => {
    expect(sanitizeUrlSegment('~user')).toBe('~user');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeUrlSegment('')).toBe('');
  });

  // --- stripping dangerous characters ---
  it('strips slashes', () => {
    expect(sanitizeUrlSegment('a/b')).toBe('ab');
  });

  it('strips backslashes', () => {
    expect(sanitizeUrlSegment('a\\b')).toBe('ab');
  });

  it('strips query-param characters', () => {
    expect(sanitizeUrlSegment('repo?ref=main')).toBe('reporefmain');
  });

  it('strips fragment characters', () => {
    expect(sanitizeUrlSegment('repo#readme')).toBe('reporeadme');
  });

  it('strips path-traversal sequences', () => {
    // `../../etc/passwd` → dots kept (4 dots), slashes stripped
    expect(sanitizeUrlSegment('../../etc/passwd')).toBe('....etcpasswd');
  });

  it('strips spaces', () => {
    expect(sanitizeUrlSegment('my repo')).toBe('myrepo');
  });

  it('strips unicode characters', () => {
    expect(sanitizeUrlSegment('café')).toBe('caf');
  });

  it('strips emoji', () => {
    expect(sanitizeUrlSegment('repo🚀name')).toBe('reponame');
  });

  it('handles a very long string', () => {
    const input = 'a?b#c/d\\e'.repeat(100);
    const result = sanitizeUrlSegment(input);
    expect(result).toBe('abcde'.repeat(100));
  });

  it('strips semicolons and ampersands', () => {
    expect(sanitizeUrlSegment('a;b&c')).toBe('abc');
  });

  it('strips percent-encoding sequences', () => {
    expect(sanitizeUrlSegment('a%20b')).toBe('a20b');
  });
});

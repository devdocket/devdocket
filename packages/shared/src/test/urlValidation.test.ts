import { describe, it, expect } from 'vitest';
import {
  isValidUrlSegment,
  isValidGitHubRepo,
  safeDecodeComponent,
  isValidRepoSlug,
  sanitizeUrlSegment,
} from '../urlValidation';

describe('isValidUrlSegment', () => {
  describe('accepts valid segments', () => {
    it.each([
      'my-org',
      'my_org',
      'my.org',
      'org123',
      'A',
      '9starts-with-number',
      'MixedCase',
      'a.b.c',
      'a-b_c.d',
    ])('accepts "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(true);
    });
  });

  describe('rejects path traversal attempts', () => {
    it.each([
      '..',
      '.',
    ])('rejects "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(false);
    });

    it.each([
      'a..b',
      '...',
      '.github',
    ])('accepts "%s" (not traversal)', (input) => {
      expect(isValidUrlSegment(input)).toBe(true);
    });
  });

  describe('rejects slashes and backslashes', () => {
    it.each([
      'org/subpath',
      'org\\subpath',
      'a//b',
    ])('rejects "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(false);
    });
  });

  describe('rejects query and fragment characters', () => {
    it.each([
      'org?malicious=param',
      'org?param',
      'org#fragment',
    ])('rejects "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(false);
    });
  });

  describe('rejects empty and non-string values', () => {
    it('rejects empty string', () => {
      expect(isValidUrlSegment('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidUrlSegment(null as unknown as string)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidUrlSegment(undefined as unknown as string)).toBe(false);
    });
  });

  describe('rejects segments starting with non-safe characters', () => {
    it('rejects whitespace-only strings', () => {
      expect(isValidUrlSegment('   ')).toBe(false);
    });
  });

  describe('accepts segments starting with dot/dash/underscore', () => {
    it.each([
      '.hidden',
      '-dash',
      '_underscore',
    ])('accepts "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(true);
    });
  });

  describe('accepts segments with other special characters', () => {
    it.each([
      'org name',
      'org@host',
      'org:port',
      'org;semi',
    ])('accepts "%s" (encoded by provider)', (input) => {
      expect(isValidUrlSegment(input)).toBe(true);
    });
  });
});

describe('isValidGitHubRepo', () => {
  describe('accepts valid owner/repo identifiers', () => {
    it.each([
      'owner/repo',
      'my-org/my-repo',
      'user123/project_v2',
      'Org/Repo.js',
    ])('accepts "%s"', (input) => {
      expect(isValidGitHubRepo(input)).toBe(true);
    });
  });

  describe('rejects invalid formats', () => {
    it('rejects single segment', () => {
      expect(isValidGitHubRepo('owner')).toBe(false);
    });

    it('rejects three segments', () => {
      expect(isValidGitHubRepo('owner/repo/extra')).toBe(false);
    });

    it('rejects traversal in owner', () => {
      expect(isValidGitHubRepo('../repo')).toBe(false);
    });

    it('rejects traversal in repo', () => {
      expect(isValidGitHubRepo('owner/..')).toBe(false);
    });

    it('accepts .github repo names', () => {
      expect(isValidGitHubRepo('owner/.github')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isValidGitHubRepo('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidGitHubRepo(null as unknown as string)).toBe(false);
    });
  });
});

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

  it('rejects a single dot owner segment', () => {
    expect(isValidRepoSlug('./repo')).toBe(false);
  });

  it('rejects a single dot repo segment', () => {
    expect(isValidRepoSlug('owner/.')).toBe(false);
  });

  it('rejects a double dot owner segment', () => {
    expect(isValidRepoSlug('../repo')).toBe(false);
  });

  it('rejects a double dot repo segment', () => {
    expect(isValidRepoSlug('owner/..')).toBe(false);
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
    // `../../etc/passwd` → slashes stripped, leading dots removed
    expect(sanitizeUrlSegment('../../etc/passwd')).toBe('etcpasswd');
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

describe('safeDecodeComponent', () => {
  it('decodes valid percent-encoded strings', () => {
    expect(safeDecodeComponent('hello%20world')).toBe('hello world');
    expect(safeDecodeComponent('foo%2Fbar')).toBe('foo/bar');
    expect(safeDecodeComponent('test%40example.com')).toBe('test@example.com');
  });

  it('decodes complex percent-encoded strings', () => {
    expect(safeDecodeComponent('%C3%A9')).toBe('é');  // UTF-8 encoded é
    expect(safeDecodeComponent('100%25')).toBe('100%');
    expect(safeDecodeComponent('a%2Bb%3Dc')).toBe('a+b=c');
  });

  it('returns original string for malformed percent-encoding', () => {
    expect(safeDecodeComponent('bad%')).toBe('bad%');
    expect(safeDecodeComponent('bad%2')).toBe('bad%2');
    expect(safeDecodeComponent('bad%ZZ')).toBe('bad%ZZ');
    expect(safeDecodeComponent('%E0%A4%A')).toBe('%E0%A4%A');  // Incomplete UTF-8 sequence
  });

  it('returns original string for already decoded input', () => {
    expect(safeDecodeComponent('hello world')).toBe('hello world');
    expect(safeDecodeComponent('foo/bar')).toBe('foo/bar');
    expect(safeDecodeComponent('no-encoding-here')).toBe('no-encoding-here');
  });

  it('handles empty and edge case strings', () => {
    expect(safeDecodeComponent('')).toBe('');
    expect(safeDecodeComponent('%')).toBe('%');
    expect(safeDecodeComponent('%%')).toBe('%%');
  });

  it('handles mixed valid and invalid encoding', () => {
    expect(safeDecodeComponent('valid%20and%ZZ')).toBe('valid%20and%ZZ');  // Stops at first error
  });
});

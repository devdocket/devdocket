import { describe, it, expect } from 'vitest';
import {
  parseRepoPatterns,
  matchesRepoPatterns,
  extractOwners,
  hasWildcardPatterns,
  isNegationOnly,
  getExactRepos,
} from '../repoPattern';

describe('parseRepoPatterns', () => {
  it('parses basic repo patterns', () => {
    const patterns = parseRepoPatterns('owner/repo');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('owner/repo');
    expect(patterns[0].isExclusion).toBe(false);
  });

  it('parses multiple patterns', () => {
    const patterns = parseRepoPatterns('owner/repo1\nowner/repo2');
    expect(patterns).toHaveLength(2);
    expect(patterns[0].pattern).toBe('owner/repo1');
    expect(patterns[1].pattern).toBe('owner/repo2');
  });

  it('parses wildcard patterns', () => {
    const patterns = parseRepoPatterns('myorg/*');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].regex.test('myorg/repo1')).toBe(true);
    expect(patterns[0].regex.test('myorg/repo2')).toBe(true);
    expect(patterns[0].regex.test('other/repo1')).toBe(false);
  });

  it('parses exclusion patterns', () => {
    const patterns = parseRepoPatterns('!owner/repo');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].isExclusion).toBe(true);
    expect(patterns[0].regex.test('owner/repo')).toBe(true);
  });

  it('skips comments', () => {
    const patterns = parseRepoPatterns('# this is a comment\nowner/repo');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('owner/repo');
  });

  it('skips empty lines', () => {
    const patterns = parseRepoPatterns('\n\nowner/repo\n\n');
    expect(patterns).toHaveLength(1);
  });

  it('trims whitespace', () => {
    const patterns = parseRepoPatterns('  owner/repo  ');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('owner/repo');
  });

  it('handles exclusion with whitespace after !', () => {
    const patterns = parseRepoPatterns('! owner/repo');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].isExclusion).toBe(true);
    expect(patterns[0].regex.test('owner/repo')).toBe(true);
  });

  it('returns empty array for empty string', () => {
    expect(parseRepoPatterns('')).toHaveLength(0);
  });

  it('returns empty for comments-only config', () => {
    expect(parseRepoPatterns('# comment\n# another')).toHaveLength(0);
  });

  it('handles mixed patterns', () => {
    const config = `# My repos
myorg/*
!myorg/archived-repo
other-owner/specific-repo
`;
    const patterns = parseRepoPatterns(config);
    expect(patterns).toHaveLength(3);
    expect(patterns[0].pattern).toBe('myorg/*');
    expect(patterns[0].isExclusion).toBe(false);
    expect(patterns[1].pattern).toBe('!myorg/archived-repo');
    expect(patterns[1].isExclusion).toBe(true);
    expect(patterns[2].pattern).toBe('other-owner/specific-repo');
    expect(patterns[2].isExclusion).toBe(false);
  });

  it('matches are case-insensitive', () => {
    const patterns = parseRepoPatterns('MyOrg/MyRepo');
    expect(patterns[0].regex.test('myorg/myrepo')).toBe(true);
    expect(patterns[0].regex.test('MYORG/MYREPO')).toBe(true);
  });

  it('escapes regex special characters in patterns', () => {
    const patterns = parseRepoPatterns('my.org/my-repo');
    expect(patterns[0].regex.test('my.org/my-repo')).toBe(true);
    expect(patterns[0].regex.test('myXorg/my-repo')).toBe(false);
  });
});

describe('matchesRepoPatterns', () => {
  it('returns false for empty patterns', () => {
    expect(matchesRepoPatterns('owner/repo', [])).toBe(false);
  });

  it('matches exact pattern', () => {
    const patterns = parseRepoPatterns('owner/repo');
    expect(matchesRepoPatterns('owner/repo', patterns)).toBe(true);
    expect(matchesRepoPatterns('owner/other', patterns)).toBe(false);
  });

  it('matches wildcard pattern', () => {
    const patterns = parseRepoPatterns('myorg/*');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(true);
    expect(matchesRepoPatterns('myorg/repo2', patterns)).toBe(true);
    expect(matchesRepoPatterns('other/repo1', patterns)).toBe(false);
  });

  it('last match wins', () => {
    const patterns = parseRepoPatterns('myorg/*\n!myorg/secret');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(true);
    expect(matchesRepoPatterns('myorg/secret', patterns)).toBe(false);
  });

  it('exclusion then inclusion restores', () => {
    const patterns = parseRepoPatterns('myorg/*\n!myorg/secret\nmyorg/secret');
    expect(matchesRepoPatterns('myorg/secret', patterns)).toBe(true);
  });

  it('negation-only: includes non-matching repos', () => {
    const patterns = parseRepoPatterns('!myorg/secret');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(true);
    expect(matchesRepoPatterns('other/repo', patterns)).toBe(true);
    expect(matchesRepoPatterns('myorg/secret', patterns)).toBe(false);
  });

  it('negation-only with wildcard', () => {
    const patterns = parseRepoPatterns('!myorg/*');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(false);
    expect(matchesRepoPatterns('other/repo', patterns)).toBe(true);
  });

  it('positive pattern does not match unmentioned repos', () => {
    const patterns = parseRepoPatterns('myorg/repo1');
    expect(matchesRepoPatterns('myorg/repo2', patterns)).toBe(false);
    expect(matchesRepoPatterns('other/repo', patterns)).toBe(false);
  });

  it('multiple positive patterns', () => {
    const patterns = parseRepoPatterns('owner/repo1\nowner/repo2');
    expect(matchesRepoPatterns('owner/repo1', patterns)).toBe(true);
    expect(matchesRepoPatterns('owner/repo2', patterns)).toBe(true);
    expect(matchesRepoPatterns('owner/repo3', patterns)).toBe(false);
  });

  it('case-insensitive matching', () => {
    const patterns = parseRepoPatterns('MyOrg/MyRepo');
    expect(matchesRepoPatterns('myorg/myrepo', patterns)).toBe(true);
    expect(matchesRepoPatterns('MYORG/MYREPO', patterns)).toBe(true);
  });
});

describe('extractOwners', () => {
  it('skips exact patterns (only returns wildcard owners)', () => {
    const patterns = parseRepoPatterns('myorg/repo');
    expect(extractOwners(patterns)).toEqual([]);
  });

  it('extracts owner from wildcard pattern', () => {
    const patterns = parseRepoPatterns('myorg/*');
    expect(extractOwners(patterns)).toEqual(['myorg']);
  });

  it('skips exact patterns even with same owner as wildcard', () => {
    const patterns = parseRepoPatterns('myorg/repo1\nmyorg/repo2');
    expect(extractOwners(patterns)).toEqual([]);
  });

  it('extracts multiple owners from wildcard patterns', () => {
    const patterns = parseRepoPatterns('org1/*\norg2/*');
    const owners = extractOwners(patterns);
    expect(owners).toContain('org1');
    expect(owners).toContain('org2');
    expect(owners).toHaveLength(2);
  });

  it('skips exclusion patterns', () => {
    const patterns = parseRepoPatterns('!excluded-org/repo');
    expect(extractOwners(patterns)).toEqual([]);
  });

  it('skips wildcard owners', () => {
    const patterns = parseRepoPatterns('*/repo');
    expect(extractOwners(patterns)).toEqual([]);
  });

  it('returns empty for empty patterns', () => {
    expect(extractOwners([])).toEqual([]);
  });
});

describe('hasWildcardPatterns', () => {
  it('returns true for wildcard patterns', () => {
    const patterns = parseRepoPatterns('myorg/*');
    expect(hasWildcardPatterns(patterns)).toBe(true);
  });

  it('returns false for exact patterns', () => {
    const patterns = parseRepoPatterns('myorg/repo');
    expect(hasWildcardPatterns(patterns)).toBe(false);
  });

  it('ignores exclusion wildcards', () => {
    const patterns = parseRepoPatterns('!myorg/*');
    expect(hasWildcardPatterns(patterns)).toBe(false);
  });
});

describe('isNegationOnly', () => {
  it('returns true when all patterns are exclusions', () => {
    const patterns = parseRepoPatterns('!myorg/repo');
    expect(isNegationOnly(patterns)).toBe(true);
  });

  it('returns false when there are positive patterns', () => {
    const patterns = parseRepoPatterns('myorg/*\n!myorg/repo');
    expect(isNegationOnly(patterns)).toBe(false);
  });

  it('returns false for empty patterns', () => {
    expect(isNegationOnly([])).toBe(false);
  });
});

describe('getExactRepos', () => {
  it('returns exact repos', () => {
    const patterns = parseRepoPatterns('owner/repo1\nowner/repo2');
    expect(getExactRepos(patterns)).toEqual(['owner/repo1', 'owner/repo2']);
  });

  it('excludes wildcard patterns', () => {
    const patterns = parseRepoPatterns('myorg/*\nmyorg/specific');
    expect(getExactRepos(patterns)).toEqual(['myorg/specific']);
  });

  it('excludes exclusion patterns', () => {
    const patterns = parseRepoPatterns('!myorg/repo');
    expect(getExactRepos(patterns)).toEqual([]);
  });
});

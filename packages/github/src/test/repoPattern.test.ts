import { describe, it, expect } from 'vitest';
import {
  parseRepoPatterns,
  matchesRepoPatterns,
} from '../repoPattern';

describe('parseRepoPatterns', () => {
  it('parses basic repo patterns', () => {
    const patterns = parseRepoPatterns('owner/repo');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('owner/repo');
    expect(patterns[0].isNegation).toBe(false);
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
    expect(patterns[0].isNegation).toBe(true);
    expect(patterns[0].regex.test('owner/repo')).toBe(true);
  });

  it('skips comments', () => {
    const patterns = parseRepoPatterns('# this is a comment\nowner/repo');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('owner/repo');
  });

  it('strips inline trailing comments', () => {
    const patterns = parseRepoPatterns('myorg/* # include all repos');
    expect(patterns).toHaveLength(1);
    // The inline comment is stripped, so the pattern is just 'myorg/*'
    expect(patterns[0].regex.test('myorg/repo1')).toBe(true);
    expect(patterns[0].regex.test('other/repo1')).toBe(false);
  });

  it('strips inline comment from negation pattern', () => {
    const patterns = parseRepoPatterns('!myorg/secret # keep this one');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].isNegation).toBe(true);
    expect(patterns[0].regex.test('myorg/secret')).toBe(true);
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
    expect(patterns[0].isNegation).toBe(true);
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
    expect(patterns[0].isNegation).toBe(false);
    expect(patterns[1].pattern).toBe('!myorg/archived-repo');
    expect(patterns[1].isNegation).toBe(true);
    expect(patterns[2].pattern).toBe('other-owner/specific-repo');
    expect(patterns[2].isNegation).toBe(false);
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
  it('returns true for empty patterns (nothing filtered)', () => {
    expect(matchesRepoPatterns('owner/repo', [])).toBe(true);
  });

  it('filters out exact match, keeps others', () => {
    const patterns = parseRepoPatterns('owner/repo');
    expect(matchesRepoPatterns('owner/repo', patterns)).toBe(false);
    expect(matchesRepoPatterns('owner/other', patterns)).toBe(true);
  });

  it('filters out wildcard matches, keeps non-matching', () => {
    const patterns = parseRepoPatterns('myorg/*');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(false);
    expect(matchesRepoPatterns('myorg/repo2', patterns)).toBe(false);
    expect(matchesRepoPatterns('other/repo1', patterns)).toBe(true);
  });

  it('last match wins — ! un-filters', () => {
    const patterns = parseRepoPatterns('myorg/*\n!myorg/secret');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(false);
    expect(matchesRepoPatterns('myorg/secret', patterns)).toBe(true);
  });

  it('re-filtering after ! restores exclusion', () => {
    const patterns = parseRepoPatterns('myorg/*\n!myorg/secret\nmyorg/secret');
    expect(matchesRepoPatterns('myorg/secret', patterns)).toBe(false);
  });

  it('negation-only: no effect (everything already included)', () => {
    const patterns = parseRepoPatterns('!myorg/secret');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(true);
    expect(matchesRepoPatterns('other/repo', patterns)).toBe(true);
    expect(matchesRepoPatterns('myorg/secret', patterns)).toBe(true);
  });

  it('negation-only with wildcard: no effect', () => {
    const patterns = parseRepoPatterns('!myorg/*');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(true);
    expect(matchesRepoPatterns('other/repo', patterns)).toBe(true);
  });

  it('non-matching repos are kept (not filtered)', () => {
    const patterns = parseRepoPatterns('myorg/repo1');
    expect(matchesRepoPatterns('myorg/repo1', patterns)).toBe(false);
    expect(matchesRepoPatterns('myorg/repo2', patterns)).toBe(true);
    expect(matchesRepoPatterns('other/repo', patterns)).toBe(true);
  });

  it('multiple patterns filter out all matched repos', () => {
    const patterns = parseRepoPatterns('owner/repo1\nowner/repo2');
    expect(matchesRepoPatterns('owner/repo1', patterns)).toBe(false);
    expect(matchesRepoPatterns('owner/repo2', patterns)).toBe(false);
    expect(matchesRepoPatterns('owner/repo3', patterns)).toBe(true);
  });

  it('case-insensitive matching', () => {
    const patterns = parseRepoPatterns('MyOrg/MyRepo');
    expect(matchesRepoPatterns('myorg/myrepo', patterns)).toBe(false);
    expect(matchesRepoPatterns('MYORG/MYREPO', patterns)).toBe(false);
  });
});

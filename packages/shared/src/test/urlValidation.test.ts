import { describe, it, expect } from 'vitest';
import { isValidUrlSegment, isValidGitHubRepo } from '../urlValidation';

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
    ])('accepts "%s" (not traversal)', (input) => {
      expect(isValidUrlSegment(input)).toBe(true);
    });

    it('rejects "..." (starts with non-alphanumeric)', () => {
      expect(isValidUrlSegment('...')).toBe(false);
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

  describe('rejects segments starting with non-alphanumeric', () => {
    it.each([
      '.hidden',
      '-dash',
      '_underscore',
    ])('rejects "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(false);
    });
  });

  describe('rejects special characters', () => {
    it.each([
      'org name',
      'org@host',
      'org:port',
      'org;semi',
    ])('rejects "%s"', (input) => {
      expect(isValidUrlSegment(input)).toBe(false);
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

    it('rejects empty string', () => {
      expect(isValidGitHubRepo('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidGitHubRepo(null as unknown as string)).toBe(false);
    });
  });
});

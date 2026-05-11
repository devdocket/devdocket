import { describe, expect, it } from 'vitest';
import { createGitHubIssueGitWork, createGitHubPrGitWork } from '../gitWorkCapabilities';

describe('gitWorkCapabilities', () => {
  describe('createGitHubIssueGitWork', () => {
    it('creates issue git work for valid GitHub repo slugs', () => {
      expect(createGitHubIssueGitWork('owner/repo', 12)).toEqual({
        kind: 'issue',
        cloneUrl: 'https://github.com/owner/repo.git',
        ref: 'issue12',
        repoLabel: 'owner/repo',
      });
    });

    it('does not create issue git work for unknown repo fallbacks', () => {
      expect(createGitHubIssueGitWork('unknown-repo-abc123', 12)).toBeUndefined();
    });
  });

  describe('createGitHubPrGitWork', () => {
    it('does not create PR git work for unknown repo fallbacks', () => {
      expect(createGitHubPrGitWork('unknown-repo-abc123', 12)).toBeUndefined();
    });
  });
});

import { describe, it, expect } from 'vitest';
import { parseSourceUrl } from '../services/urlParser';

describe('parseSourceUrl', () => {
  describe('GitHub PR URLs', () => {
    it('parses a basic GitHub PR URL', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/pull/123');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 123 });
    });

    it('parses with trailing slash', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/pull/456/');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 456 });
    });

    it('parses with query string', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/pull/789?diff=unified');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 789 });
    });

    it('parses with fragment', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/pull/42#issuecomment-123');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 42 });
    });

    it('parses with /files subpath', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/pull/99/files');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 99 });
    });

    it('parses http (non-https) URL', () => {
      const result = parseSourceUrl('http://github.com/owner/repo/pull/1');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 1 });
    });

    it('trims whitespace', () => {
      const result = parseSourceUrl('  https://github.com/owner/repo/pull/5  ');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 5 });
    });

    it('handles hyphenated owner/repo names', () => {
      const result = parseSourceUrl('https://github.com/my-org/my-repo/pull/10');
      expect(result).toEqual({ type: 'github-pr', owner: 'my-org', repo: 'my-repo', number: 10 });
    });

    it('decodes percent-encoded owner/repo names', () => {
      const result = parseSourceUrl('https://github.com/my%20org/my%20repo/pull/10');
      expect(result).toEqual({ type: 'github-pr', owner: 'my org', repo: 'my repo', number: 10 });
    });

    it('handles mixed-case scheme and hostname', () => {
      const result = parseSourceUrl('HTTPS://GitHub.COM/owner/repo/pull/99');
      expect(result).toEqual({ type: 'github-pr', owner: 'owner', repo: 'repo', number: 99 });
    });
  });

  describe('Azure DevOps PR URLs', () => {
    it('parses a basic ADO PR URL', () => {
      const result = parseSourceUrl('https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42');
      expect(result).toEqual({ type: 'ado-pr', org: 'myorg', project: 'myproject', repo: 'myrepo', id: 42 });
    });

    it('parses with trailing slash', () => {
      const result = parseSourceUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/7/');
      expect(result).toEqual({ type: 'ado-pr', org: 'org', project: 'proj', repo: 'repo', id: 7 });
    });

    it('parses with query string', () => {
      const result = parseSourceUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/100?_a=overview');
      expect(result).toEqual({ type: 'ado-pr', org: 'org', project: 'proj', repo: 'repo', id: 100 });
    });

    it('parses http (non-https) URL', () => {
      const result = parseSourceUrl('http://dev.azure.com/org/proj/_git/repo/pullrequest/3');
      expect(result).toEqual({ type: 'ado-pr', org: 'org', project: 'proj', repo: 'repo', id: 3 });
    });

    it('handles hyphenated segments', () => {
      const result = parseSourceUrl('https://dev.azure.com/my-org/my-project/_git/my-repo/pullrequest/55');
      expect(result).toEqual({ type: 'ado-pr', org: 'my-org', project: 'my-project', repo: 'my-repo', id: 55 });
    });
  });

  describe('GitHub issue URLs', () => {
    it('parses a basic GitHub issue URL', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/issues/123');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 123 });
    });

    it('parses with trailing slash', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/issues/456/');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 456 });
    });

    it('parses with query string', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/issues/789?ref=main');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 789 });
    });

    it('parses with fragment', () => {
      const result = parseSourceUrl('https://github.com/owner/repo/issues/42#issuecomment-999');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 42 });
    });

    it('parses http (non-https) URL', () => {
      const result = parseSourceUrl('http://github.com/owner/repo/issues/1');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 1 });
    });

    it('trims whitespace', () => {
      const result = parseSourceUrl('  https://github.com/owner/repo/issues/5  ');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 5 });
    });

    it('handles hyphenated owner/repo names', () => {
      const result = parseSourceUrl('https://github.com/my-org/my-repo/issues/10');
      expect(result).toEqual({ type: 'github-issue', owner: 'my-org', repo: 'my-repo', number: 10 });
    });

    it('handles mixed-case scheme and hostname', () => {
      const result = parseSourceUrl('HTTPS://GitHub.COM/owner/repo/issues/99');
      expect(result).toEqual({ type: 'github-issue', owner: 'owner', repo: 'repo', number: 99 });
    });
  });

  describe('Azure DevOps work item URLs', () => {
    it('parses a basic ADO work item URL', () => {
      const result = parseSourceUrl('https://dev.azure.com/myorg/myproject/_workitems/edit/42');
      expect(result).toEqual({ type: 'ado-workitem', org: 'myorg', project: 'myproject', id: 42 });
    });

    it('parses with trailing slash', () => {
      const result = parseSourceUrl('https://dev.azure.com/org/proj/_workitems/edit/7/');
      expect(result).toEqual({ type: 'ado-workitem', org: 'org', project: 'proj', id: 7 });
    });

    it('parses with query string', () => {
      const result = parseSourceUrl('https://dev.azure.com/org/proj/_workitems/edit/100?fullScreen=true');
      expect(result).toEqual({ type: 'ado-workitem', org: 'org', project: 'proj', id: 100 });
    });

    it('parses http (non-https) URL', () => {
      const result = parseSourceUrl('http://dev.azure.com/org/proj/_workitems/edit/3');
      expect(result).toEqual({ type: 'ado-workitem', org: 'org', project: 'proj', id: 3 });
    });

    it('handles hyphenated segments', () => {
      const result = parseSourceUrl('https://dev.azure.com/my-org/my-project/_workitems/edit/55');
      expect(result).toEqual({ type: 'ado-workitem', org: 'my-org', project: 'my-project', id: 55 });
    });
  });

  describe('invalid URLs', () => {
    it('returns undefined for empty string', () => {
      expect(parseSourceUrl('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only', () => {
      expect(parseSourceUrl('   ')).toBeUndefined();
    });

    it('returns undefined for plain text', () => {
      expect(parseSourceUrl('not a url')).toBeUndefined();
    });

    it('returns undefined for GitHub actions URL', () => {
      expect(parseSourceUrl('https://github.com/owner/repo/actions/runs/123')).toBeUndefined();
    });

    it('returns undefined for GitHub repo URL without PR', () => {
      expect(parseSourceUrl('https://github.com/owner/repo')).toBeUndefined();
    });

    it('returns undefined for non-GitHub, non-ADO URL', () => {
      expect(parseSourceUrl('https://gitlab.com/owner/repo/merge_requests/1')).toBeUndefined();
    });

    it('returns undefined for ADO URL missing pullrequest segment', () => {
      expect(parseSourceUrl('https://dev.azure.com/org/proj/_git/repo')).toBeUndefined();
    });
  });
});

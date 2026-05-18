import { describe, expect, it } from 'vitest';
import { parseAdoPrUrl, parsePrUrl } from '../prUrl';

describe('prUrl parsers', () => {
  it('parses a valid GitHub PR URL', () => {
    expect(parsePrUrl('https://github.com/devdocket/devdocket/pull/42')).toEqual({
      org: 'devdocket',
      repo: 'devdocket',
      prNumber: '42',
    });
  });

  it('rejects non-http GitHub URLs', () => {
    expect(parsePrUrl('ftp://github.com/devdocket/devdocket/pull/42')).toBeUndefined();
  });

  it('parses a valid ADO PR URL with encoded path segments', () => {
    expect(parseAdoPrUrl('https://dev.azure.com/my%20org/My%20Project/_git/my%20repo/pullrequest/7')).toEqual({
      org: 'my org',
      project: 'My Project',
      repo: 'my repo',
      prId: '7',
    });
  });

  it('rejects non-http ADO URLs', () => {
    expect(parseAdoPrUrl('ftp://dev.azure.com/org/project/_git/repo/pullrequest/7')).toBeUndefined();
  });
});

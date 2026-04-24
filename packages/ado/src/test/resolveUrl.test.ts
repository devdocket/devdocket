import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { AdoPrReviewProvider } from '../adoPrReviewProvider';
import { AdoWorkItemProvider } from '../adoWorkItemProvider';

const mockFetch = vi.fn();

describe('AdoPrReviewProvider.resolveUrl', () => {
  let provider: AdoPrReviewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: [] }]);

    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('returns undefined for non-ADO-PR URLs', async () => {
    const result = await provider.resolveUrl('https://github.com/owner/repo/pull/42');
    expect(result).toBeUndefined();
  });

  it('returns undefined for ADO work item URLs', async () => {
    const result = await provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_workitems/edit/99');
    expect(result).toBeUndefined();
  });

  it('returns correct ResolvedItem for valid ADO PR URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pullRequestId: 42,
        title: 'Fix critical bug',
        description: 'This PR fixes a critical issue',
        repository: {
          name: 'myrepo',
          project: { name: 'MyProject' },
          webUrl: 'https://dev.azure.com/myorg/MyProject/_git/myrepo',
        },
      }),
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
    );

    expect(result).toEqual({
      title: '#42: Fix critical bug',
      notes: 'This PR fixes a critical issue',
      url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
      externalId: 'myorg/MyProject/myrepo/42',
      group: 'MyProject/myrepo',
      providerId: 'ado-pr-reviews',
      isPullRequest: true,
    });
  });

  it('uses canonical names from API in externalId and group', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pullRequestId: 99,
        title: 'Test PR',
        description: '',
        repository: {
          name: 'canonical-repo-name',
          project: { name: 'CanonicalProjectName' },
          webUrl: 'https://dev.azure.com/myorg/CanonicalProjectName/_git/canonical-repo-name',
        },
      }),
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/SomeProject/_git/somerepo/pullrequest/99',
    );

    expect(result?.externalId).toBe('myorg/CanonicalProjectName/canonical-repo-name/99');
    expect(result?.group).toBe('CanonicalProjectName/canonical-repo-name');
  });

  it('throws on 404 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(
      provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/999'),
    ).rejects.toThrow('not found');
  });

  it('throws on 401 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42'),
    ).rejects.toThrow('authentication required');
  });

  it('throws on 403 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(
      provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42'),
    ).rejects.toThrow('authentication required');
  });

  it('handles null description gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pullRequestId: 42,
        title: 'No description',
        description: null,
        repository: {
          name: 'myrepo',
          project: { name: 'MyProject' },
          webUrl: 'https://dev.azure.com/myorg/MyProject/_git/myrepo',
        },
      }),
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
    );

    expect(result?.notes).toBe('');
  });

  it('handles URL with encoded segments', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pullRequestId: 5,
        title: 'Encoded URL test',
        description: '',
        repository: {
          name: 'my-repo',
          project: { name: 'My Project' },
          webUrl: 'https://dev.azure.com/my-org/My%20Project/_git/my-repo',
        },
      }),
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/my-org/My%20Project/_git/my-repo/pullrequest/5',
    );

    expect(result).toBeDefined();
    expect(result?.externalId).toBe('my-org/My Project/my-repo/5');
  });

  it('retries with auth on 404 when unauthenticated', async () => {
    // First, make getSession return undefined for the silent check
    vi.mocked(authentication.getSession).mockResolvedValueOnce(undefined as any);
    
    // Then return a session for the retry
    vi.mocked(authentication.getSession).mockResolvedValueOnce({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pullRequestId: 42,
          title: 'Private PR now visible',
          description: 'Was private, auth helps',
          repository: {
            name: 'myrepo',
            project: { name: 'MyProject' },
            webUrl: 'https://dev.azure.com/myorg/MyProject/_git/myrepo',
          },
        }),
      });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
    );

    expect(result).toBeDefined();
    expect(result?.title).toBe('#42: Private PR now visible');
    // Verify retry was made with auth
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://dev.azure.com/myorg/MyProject/_apis/git/repositories/myrepo/pullrequests/42?api-version=7.1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});

describe('AdoWorkItemProvider.resolveUrl', () => {
  let provider: AdoWorkItemProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]);

    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    // Default mock for states API (no terminal states by default)
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch call in test: ${String(url)}`);
    });
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('returns undefined for non-work-item URLs', async () => {
    const result = await provider.resolveUrl('https://github.com/owner/repo/issues/99');
    expect(result).toBeUndefined();
  });

  it('returns undefined for ADO PR URLs', async () => {
    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
    );
    expect(result).toBeUndefined();
  });

  it('returns correct ResolvedItem for valid work item URL', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wit/workitems/99')) {
        return {
          ok: true,
          json: async () => ({
            id: 99,
            fields: {
              'System.Title': 'Implement feature X',
              'System.Description': '<p>Add support for new feature</p>',
              'System.TeamProject': 'MyProject',
              'System.WorkItemType': 'User Story',
            },
            _links: {
              html: { href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/99' },
            },
          }),
        };
      }
      if (url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_workitems/edit/99',
    );

    expect(result).toEqual({
      title: '#99: Implement feature X',
      notes: 'Add support for new feature',
      url: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/99',
      externalId: 'myorg/MyProject/99',
      group: 'myorg/MyProject',
      providerId: 'ado-work-items',
    });
  });

  it('strips HTML tags from description', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wit/workitems/5')) {
        return {
          ok: true,
          json: async () => ({
            id: 5,
            fields: {
              'System.Title': 'Task with HTML',
              'System.Description': '<div><b>Bold text</b> and <a href="http://example.com">link</a></div>',
              'System.TeamProject': 'MyProject',
              'System.WorkItemType': 'Task',
            },
            _links: {
              html: { href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/5' },
            },
          }),
        };
      }
      if (url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_workitems/edit/5',
    );

    expect(result?.notes).toBe('Bold text and link');
  });

  it('handles complex HTML with br and p tags', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wit/workitems/7')) {
        return {
          ok: true,
          json: async () => ({
            id: 7,
            fields: {
              'System.Title': 'Complex HTML',
              'System.Description':
                '<p>First paragraph</p><br/><p>Second paragraph</p><br/><p>Third</p>',
              'System.TeamProject': 'MyProject',
              'System.WorkItemType': 'Bug',
            },
            _links: {
              html: { href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/7' },
            },
          }),
        };
      }
      if (url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_workitems/edit/7',
    );

    // HTML entities and line breaks should be cleaned up
    expect(result?.notes).toContain('First paragraph');
    expect(result?.notes).toContain('Second paragraph');
  });

  it('handles null description gracefully', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wit/workitems/10')) {
        return {
          ok: true,
          json: async () => ({
            id: 10,
            fields: {
              'System.Title': 'No description',
              'System.Description': null,
              'System.TeamProject': 'MyProject',
              'System.WorkItemType': 'Task',
            },
            _links: {
              html: { href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/10' },
            },
          }),
        };
      }
      if (url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_workitems/edit/10',
    );

    expect(result?.notes).toBe('');
  });

  it('throws on 404 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(
      provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_workitems/edit/999'),
    ).rejects.toThrow('not found');
  });

  it('throws on 401 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_workitems/edit/99'),
    ).rejects.toThrow('authentication required');
  });

  it('throws on 403 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(
      provider.resolveUrl('https://dev.azure.com/myorg/MyProject/_workitems/edit/99'),
    ).rejects.toThrow('authentication required');
  });

  it('uses canonical team project name from API', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wit/workitems/50')) {
        return {
          ok: true,
          json: async () => ({
            id: 50,
            fields: {
              'System.Title': 'Canonical names test',
              'System.Description': '',
              'System.TeamProject': 'CanonicalProjectName',
              'System.WorkItemType': 'Task',
            },
            _links: {
              html:
                'https://dev.azure.com/myorg/CanonicalProjectName/_workitems/edit/50',
            },
          }),
        };
      }
      if (url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/SomeProject/_workitems/edit/50',
    );

    expect(result?.externalId).toBe('myorg/CanonicalProjectName/50');
    expect(result?.group).toBe('myorg/CanonicalProjectName');
  });

  it('handles URL with encoded segments', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wit/workitems/15')) {
        return {
          ok: true,
          json: async () => ({
            id: 15,
            fields: {
              'System.Title': 'Encoded URL test',
              'System.Description': '',
              'System.TeamProject': 'My Project',
              'System.WorkItemType': 'Bug',
            },
            _links: {
              html: 'https://dev.azure.com/my-org/My%20Project/_workitems/edit/15',
            },
          }),
        };
      }
      if (url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/my-org/My%20Project/_workitems/edit/15',
    );

    expect(result).toBeDefined();
    expect(result?.externalId).toBe('my-org/My Project/15');
  });

  it('retries with auth on 404 when unauthenticated', async () => {
    // First, make getSession return undefined for the silent check
    vi.mocked(authentication.getSession).mockResolvedValueOnce(undefined as any);
    
    // Then return a session for the retry
    vi.mocked(authentication.getSession).mockResolvedValueOnce({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 99,
          fields: {
            'System.Title': 'Private item now visible',
            'System.Description': 'Auth helps',
            'System.TeamProject': 'MyProject',
            'System.WorkItemType': 'User Story',
          },
          _links: {
            html: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/99',
          },
        }),
      });

    const result = await provider.resolveUrl(
      'https://dev.azure.com/myorg/MyProject/_workitems/edit/99',
    );

    expect(result).toBeDefined();
    expect(result?.title).toBe('#99: Private item now visible');
    // Verify retry was made with auth
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://dev.azure.com/myorg/MyProject/_apis/wit/workitems/99?api-version=7.1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});

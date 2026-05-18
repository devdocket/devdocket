import { describe, it, expect, vi } from 'vitest';
import { AdoPrClient, normalizeAdoFilePath } from '../adoPrClient';

const parts = {
  org: 'my org',
  project: 'My Project',
  repo: 'my repo',
  prId: '42',
};

function session() {
  return Promise.resolve({ accessToken: 'ado-token' } as never);
}

function response(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  } as never;
}

describe('AdoPrClient', () => {
  it('fetches PR metadata and commit diff from Azure DevOps', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        lastMergeTargetCommit: { commitId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      }))
      .mockResolvedValueOnce(response({
        changes: [
          { changeType: 'edit', item: { path: '/src/app.ts' } },
          { changeType: 'add', item: { path: '/src/new.ts' } },
        ],
      }));

    const client = new AdoPrClient(fetchMock as never, session);
    const result = await client.fetchDiffResult(parts);
    const diff = result?.diff;

    expect(result?.synthetic).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://dev.azure.com/my%20org/My%20Project/_apis/git/repositories/my%20repo/pullrequests/42?api-version=7.1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ado-token' }),
      }),
    );
    const diffUrl = String(fetchMock.mock.calls[1][0]);
    expect(diffUrl).toContain('/diffs/commits?');
    expect(diffUrl).toContain('baseVersion=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(diffUrl).toContain('targetVersion=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(diff).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(diff).toContain('@@ Azure DevOps change: edit @@');
  });

  it('strips refs/heads prefixes when commit IDs are unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        sourceRefName: 'refs/heads/feature/add-api',
        targetRefName: 'refs/heads/main',
      }))
      .mockResolvedValueOnce(response({ changes: [] }));

    const client = new AdoPrClient(fetchMock as never, session);
    const diff = await client.fetchDiff(parts);

    expect(diff).toBe('');
    const diffUrl = String(fetchMock.mock.calls[1][0]);
    expect(diffUrl).toContain('baseVersion=main');
    expect(diffUrl).toContain('baseVersionType=branch');
    expect(diffUrl).toContain('targetVersion=feature%2Fadd-api');
    expect(diffUrl).toContain('targetVersionType=branch');
    expect(diffUrl).not.toContain('refs%2Fheads');
  });

  it('returns an empty diff for folder-only ADO responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
      }))
      .mockResolvedValueOnce(response({ changes: [{ item: { path: '/src', isFolder: true } }] }));

    const client = new AdoPrClient(fetchMock as never, session);
    const result = await client.fetchDiffResult(parts);

    expect(result).toEqual({ diff: '', synthetic: false });
  });

  it('returns unified diff text when ADO returns a patch body', async () => {
    const unified = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        lastMergeSourceCommit: { commitId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        lastMergeTargetCommit: { commitId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      }))
      .mockResolvedValueOnce(response(unified));

    const client = new AdoPrClient(fetchMock as never, session);
    const result = await client.fetchDiffResult(parts);
    expect(result).toEqual({ diff: unified, synthetic: false });
  });

  it('treats ADO JSON responses with inline patches as usable diffs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        lastMergeTargetCommit: { commitId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      }))
      .mockResolvedValueOnce(response({
        changes: [
          {
            changeType: 'edit',
            item: { path: '/src/app.ts' },
            patch: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      }));

    const client = new AdoPrClient(fetchMock as never, session);
    const result = await client.fetchDiffResult(parts);

    expect(result?.synthetic).toBe(false);
    expect(result?.diff).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(result?.diff).toContain('@@ -1 +1 @@');
    expect(result?.diff).not.toContain('Azure DevOps returned change metadata');
  });

  it('marks mixed inline and metadata-only JSON responses as synthetic', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        lastMergeTargetCommit: { commitId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      }))
      .mockResolvedValueOnce(response({
        changes: [
          {
            changeType: 'edit',
            item: { path: '/src/app.ts' },
            patch: '@@ -1 +1 @@\n-old\n+new',
          },
          { changeType: 'edit', item: { path: '/src/metadata-only.ts' } },
        ],
      }));

    const client = new AdoPrClient(fetchMock as never, session);
    const result = await client.fetchDiffResult(parts);

    expect(result?.synthetic).toBe(true);
    expect(result?.diff).toContain('Azure DevOps returned change metadata');
    expect(result?.diff).toContain('@@ Azure DevOps change: edit @@');
  });

  it('posts a line-level ADO review thread with right-side context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 123 }));
    const client = new AdoPrClient(fetchMock as never, session);

    await client.postThread(parts, {
      content: 'Please guard this null value.',
      filePath: 'src/app.ts',
      line: 17,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dev.azure.com/my%20org/My%20Project/_apis/git/repositories/my%20repo/pullrequests/42/threads?api-version=7.1-preview.1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ado-token',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      comments: [
        {
          parentCommentId: 0,
          content: 'Please guard this null value.',
          commentType: 'text',
        },
      ],
      status: 'active',
      threadContext: {
        filePath: '/src/app.ts',
        rightFileStart: { line: 17, offset: 1 },
        rightFileEnd: { line: 17, offset: 1 },
      },
    });
  });

  it('posts a general ADO review thread when no file path is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 123 }));
    const client = new AdoPrClient(fetchMock as never, session);

    await client.postThread(parts, { content: 'Overall review summary.' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.threadContext).toBeUndefined();
  });

  it('normalizes ADO file paths', () => {
    expect(normalizeAdoFilePath('src\\app.ts')).toBe('/src/app.ts');
    expect(normalizeAdoFilePath('/src/app.ts')).toBe('/src/app.ts');
  });
});

import * as vscode from 'vscode';
import type { AdoPrUrlParts } from './prUrl';

// Azure DevOps' first-party Microsoft Entra resource ID, matching packages/ado auth.
export const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
export const ADO_SYNTHETIC_DIFF_NOTICE = 'Azure DevOps returned change metadata; when a local worktree is available DevDocket replaces this with a full git diff.';
const ADO_API_VERSION = '7.1';
const ADO_THREADS_API_VERSION = '7.1-preview.1';

export interface AdoPullRequestDetails {
  pullRequestId: number;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeSourceCommit?: { commitId?: string };
  lastMergeTargetCommit?: { commitId?: string };
  repository?: {
    id?: string;
    name?: string;
    remoteUrl?: string;
    webUrl?: string;
    project?: { name?: string };
  };
}

export interface AdoThreadCommentInput {
  content: string;
  filePath?: string;
  line?: number;
}

export interface AdoDiffResult {
  diff: string;
  synthetic: boolean;
}

interface AdoCommitDiffChange {
  changeType?: string;
  item?: { path?: string; isFolder?: boolean };
  originalPath?: string;
  sourceServerItem?: string;
  targetServerItem?: string;
  diff?: string;
  patch?: string;
}

interface AdoCommitDiffResponse {
  changes?: AdoCommitDiffChange[];
}

type FetchLike = typeof fetch;
type SessionProvider = (createIfNone: boolean) => Promise<vscode.AuthenticationSession | undefined>;

export class AdoPrClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly getSessionImpl: SessionProvider = async createIfNone => vscode.authentication.getSession(
      'microsoft',
      [ADO_AUTH_SCOPE],
      { createIfNone },
    ),
  ) {}

  async fetchPullRequestDetails(parts: AdoPrUrlParts): Promise<AdoPullRequestDetails | undefined> {
    const session = await this.getSessionImpl(true);
    if (!session) return undefined;

    const response = await this.fetchImpl(this.prApiUrl(parts), {
      headers: this.jsonHeaders(session.accessToken),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Azure DevOps API returned ${response.status} fetching PR metadata`);
    }

    return response.json() as Promise<AdoPullRequestDetails>;
  }

  async fetchDiff(parts: AdoPrUrlParts): Promise<string | undefined> {
    const result = await this.fetchDiffResult(parts);
    return result?.diff;
  }

  async fetchDiffResult(parts: AdoPrUrlParts): Promise<AdoDiffResult | undefined> {
    const session = await this.getSessionImpl(true);
    if (!session) return undefined;

    const detailsResponse = await this.fetchImpl(this.prApiUrl(parts), {
      headers: this.jsonHeaders(session.accessToken),
      signal: AbortSignal.timeout(30_000),
    });

    if (!detailsResponse.ok) {
      throw new Error(`Azure DevOps API returned ${detailsResponse.status} fetching PR metadata`);
    }

    const details = await detailsResponse.json() as AdoPullRequestDetails;
    const baseVersion = details.lastMergeTargetCommit?.commitId ?? details.targetRefName;
    const targetVersion = details.lastMergeSourceCommit?.commitId ?? details.sourceRefName;
    if (!baseVersion || !targetVersion) {
      throw new Error('Azure DevOps PR metadata did not include source and target versions');
    }

    const diffResponse = await this.fetchImpl(this.diffApiUrl(parts, baseVersion, targetVersion), {
      headers: this.jsonHeaders(session.accessToken),
      signal: AbortSignal.timeout(30_000),
    });

    if (!diffResponse.ok) {
      throw new Error(`Azure DevOps API returned ${diffResponse.status} fetching PR diff`);
    }

    const body = await diffResponse.text();
    if (body.trimStart().startsWith('diff --git')) {
      return { diff: body, synthetic: false };
    }

    const parsed = parseJson<AdoCommitDiffResponse>(body);
    if (!parsed) {
      return { diff: body, synthetic: false };
    }

    return { diff: renderAdoDiffSummary(parts, details, parsed), synthetic: true };
  }

  async postThread(parts: AdoPrUrlParts, comment: AdoThreadCommentInput): Promise<void> {
    const session = await this.getSessionImpl(true);
    if (!session) {
      throw new Error('Azure DevOps authentication is required to post review comments');
    }

    const trimmed = comment.content.trim();
    if (!trimmed) {
      throw new Error('Azure DevOps review comment content cannot be empty');
    }

    const body: Record<string, unknown> = {
      comments: [
        {
          parentCommentId: 0,
          content: trimmed,
          commentType: 'text',
        },
      ],
      status: 'active',
    };

    if (comment.filePath && Number.isInteger(comment.line) && comment.line! > 0) {
      const filePath = normalizeAdoFilePath(comment.filePath);
      body.threadContext = {
        filePath,
        rightFileStart: { line: comment.line, offset: 1 },
        rightFileEnd: { line: comment.line, offset: 1 },
      };
    }

    const response = await this.fetchImpl(this.threadsApiUrl(parts), {
      method: 'POST',
      headers: {
        ...this.jsonHeaders(session.accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Azure DevOps API returned ${response.status} posting review thread`);
    }
  }

  private prApiUrl(parts: AdoPrUrlParts): string {
    return `${this.repoApiBase(parts)}/pullrequests/${encodeURIComponent(parts.prId)}?api-version=${ADO_API_VERSION}`;
  }

  private diffApiUrl(parts: AdoPrUrlParts, baseVersion: string, targetVersion: string): string {
    const base = normalizeAdoVersion(baseVersion);
    const target = normalizeAdoVersion(targetVersion);
    const params = new URLSearchParams({
      baseVersion: base.value,
      baseVersionType: base.type,
      targetVersion: target.value,
      targetVersionType: target.type,
      diffCommonCommit: 'true',
      'api-version': ADO_API_VERSION,
    });
    return `${this.repoApiBase(parts)}/diffs/commits?${params.toString()}`;
  }

  private threadsApiUrl(parts: AdoPrUrlParts): string {
    return `${this.repoApiBase(parts)}/pullrequests/${encodeURIComponent(parts.prId)}/threads?api-version=${ADO_THREADS_API_VERSION}`;
  }

  private repoApiBase(parts: AdoPrUrlParts): string {
    return `https://dev.azure.com/${encodeURIComponent(parts.org)}/${encodeURIComponent(parts.project)}/_apis/git/repositories/${encodeURIComponent(parts.repo)}`;
  }

  private jsonHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'DevDocket-VSCode',
    };
  }
}

export function normalizeAdoFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `/${normalized}`;
}

function renderAdoDiffSummary(
  parts: AdoPrUrlParts,
  details: AdoPullRequestDetails,
  response: AdoCommitDiffResponse,
): string {
  const changes = response.changes ?? [];
  const header = [
    `# Azure DevOps PR ${parts.org}/${parts.project}/${parts.repo}#${parts.prId}`,
    `# Source: ${details.sourceRefName ?? details.lastMergeSourceCommit?.commitId ?? 'unknown'}`,
    `# Target: ${details.targetRefName ?? details.lastMergeTargetCommit?.commitId ?? 'unknown'}`,
    `# Note: ${ADO_SYNTHETIC_DIFF_NOTICE}`,
    '',
  ];

  if (changes.length === 0) {
    return `${header.join('\n')}(no diff)`;
  }

  const rendered = changes
    .filter(change => !change.item?.isFolder)
    .map(change => renderChange(change))
    .join('\n');
  return `${header.join('\n')}${rendered}`;
}

function renderChange(change: AdoCommitDiffChange): string {
  const rawPath = change.item?.path ?? change.targetServerItem ?? change.sourceServerItem ?? change.originalPath ?? 'unknown';
  const path = rawPath.replace(/^\/+/, '');
  const changeType = change.changeType ?? 'edit';
  const inlineDiff = change.diff ?? change.patch;
  if (inlineDiff) {
    return inlineDiff.trimEnd() + '\n';
  }

  const isAdd = changeType.toLowerCase().includes('add');
  const isDelete = changeType.toLowerCase().includes('delete');
  return [
    `diff --git a/${path} b/${path}`,
    isAdd ? '--- /dev/null' : `--- a/${path}`,
    isDelete ? '+++ /dev/null' : `+++ b/${path}`,
    `@@ Azure DevOps change: ${changeType} @@`,
    `# ${normalizeAdoFilePath(path)}`,
    '',
  ].join('\n');
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function normalizeAdoVersion(value: string): { value: string; type: 'commit' | 'branch' | 'tag' } {
  if (looksLikeCommit(value)) {
    return { value, type: 'commit' };
  }
  if (value.startsWith('refs/heads/')) {
    return { value: value.slice('refs/heads/'.length), type: 'branch' };
  }
  if (value.startsWith('refs/tags/')) {
    return { value: value.slice('refs/tags/'.length), type: 'tag' };
  }
  return { value, type: 'branch' };
}

function looksLikeCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

/**
 * Fetches work item details from source URLs (GitHub PRs/issues, ADO PRs/work items).
 * Uses public REST APIs where possible, falling back to authenticated
 * requests when a VS Code auth session is available.
 * On 404, retries with interactive auth to handle private repos.
 */

import * as vscode from 'vscode';
import { type ParsedUrl } from './urlParser';
import { logger } from './logger';

// Azure DevOps resource ID — must match the scope used by the ADO provider package
const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export interface FetchedItemDetails {
  title: string;
  notes: string;
  url: string;
  /** Provider-format identifier for deduplication (matches what the live provider emits). */
  externalId: string;
  group: string;
  providerId: string;
}

/**
 * Fetch details for a parsed source URL.
 * Throws on network or API errors with a user-friendly message.
 */
export async function fetchItemDetails(parsed: ParsedUrl, signal?: AbortSignal): Promise<FetchedItemDetails> {
  switch (parsed.type) {
    case 'github-pr':
      return fetchGitHubPr(parsed.owner, parsed.repo, parsed.number, signal);
    case 'github-issue':
      return fetchGitHubIssue(parsed.owner, parsed.repo, parsed.number, signal);
    case 'ado-pr':
      return fetchAdoPr(parsed.org, parsed.project, parsed.repo, parsed.id, signal);
    case 'ado-workitem':
      return fetchAdoWorkItem(parsed.org, parsed.project, parsed.id, signal);
  }
}

/** Try silent GitHub auth first; on 404 retry with interactive auth prompt. */
async function getGitHubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'DevDocket-VSCode',
  };
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    if (session) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
  } catch {
    logger.debug('No GitHub auth session available, using unauthenticated request');
  }
  return headers;
}

async function retryGitHubWithAuth(apiUrl: string, signal?: AbortSignal): Promise<Response | undefined> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    if (session) {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'DevDocket-VSCode',
        'Authorization': `Bearer ${session.accessToken}`,
      };
      return await fetch(apiUrl, { headers, signal });
    }
  } catch {
    logger.debug('User declined GitHub authentication prompt');
  }
  return undefined;
}

/** Try silent ADO auth first; on 404 retry with interactive auth prompt. */
async function getAdoHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'DevDocket-VSCode',
  };
  try {
    const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { silent: true });
    if (session) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
  } catch {
    logger.debug('No Azure DevOps auth session available, using unauthenticated request');
  }
  return headers;
}

async function retryAdoWithAuth(apiUrl: string, signal?: AbortSignal): Promise<Response | undefined> {
  try {
    const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { createIfNone: true });
    if (session) {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'DevDocket-VSCode',
        'Authorization': `Bearer ${session.accessToken}`,
      };
      return await fetch(apiUrl, { headers, signal });
    }
  } catch {
    logger.debug('User declined Azure DevOps authentication prompt');
  }
  return undefined;
}

function handleGitHubError(response: Response, label: string): never {
  if (response.status === 404) {
    throw new Error(`${label} not found. It may be private or deleted.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`GitHub access denied for ${label}. The repo may be private — sign in to GitHub in VS Code, or check rate limits.`);
  }
  throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
}

function handleAdoError(response: Response, label: string): never {
  if (response.status === 404) {
    throw new Error(`${label} not found. It may be private or deleted.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`ADO authentication required for ${label}. Sign in to Azure DevOps in VS Code.`);
  }
  throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
}

async function fetchGitHubPr(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<FetchedItemDetails> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const label = `GitHub PR ${owner}/${repo}#${number}`;
  const headers = await getGitHubHeaders();

  let response = await fetch(apiUrl, { headers, signal });

  // On 404, retry with interactive auth in case the repo is private
  if (response.status === 404 && !signal?.aborted) {
    const retryResponse = await retryGitHubWithAuth(apiUrl, signal);
    if (retryResponse) { response = retryResponse; }
  }

  if (!response.ok) { handleGitHubError(response, label); }

  const data = await response.json() as { title: string; body: string | null; html_url: string };
  return {
    title: data.title,
    notes: data.body ?? '',
    url: data.html_url,
    externalId: `${owner}/${repo}#${number}`,
    group: `${owner}/${repo}`,
    providerId: 'github-pr-reviews',
  };
}

async function fetchGitHubIssue(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<FetchedItemDetails> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  const label = `GitHub issue ${owner}/${repo}#${number}`;
  const headers = await getGitHubHeaders();

  let response = await fetch(apiUrl, { headers, signal });

  if (response.status === 404 && !signal?.aborted) {
    const retryResponse = await retryGitHubWithAuth(apiUrl, signal);
    if (retryResponse) { response = retryResponse; }
  }

  if (!response.ok) { handleGitHubError(response, label); }

  const data = await response.json() as { title: string; body: string | null; html_url: string };
  return {
    title: data.title,
    notes: data.body ?? '',
    url: data.html_url,
    externalId: `${owner}/${repo}#${number}`,
    group: `${owner}/${repo}`,
    providerId: 'github',
  };
}

async function fetchAdoPr(org: string, project: string, repo: string, id: number, signal?: AbortSignal): Promise<FetchedItemDetails> {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}?api-version=7.1`;
  const label = `ADO PR ${org}/${project}/${repo}#${id}`;
  const headers = await getAdoHeaders();

  let response = await fetch(apiUrl, { headers, signal });

  if (response.status === 404 && !signal?.aborted) {
    const retryResponse = await retryAdoWithAuth(apiUrl, signal);
    if (retryResponse) { response = retryResponse; }
  }

  if (!response.ok) { handleAdoError(response, label); }

  const data = await response.json() as { title: string; description: string | null; repository: { name: string; project: { name: string } } };
  const projectName = data.repository.project.name;
  const repoName = data.repository.name;
  const htmlUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
  return {
    title: data.title,
    notes: data.description ?? '',
    url: htmlUrl,
    externalId: `${org}/${projectName}/${repoName}/${id}`,
    group: `${org}/${projectName}`,
    providerId: 'ado-pr-reviews',
  };
}

async function fetchAdoWorkItem(org: string, project: string, id: number, signal?: AbortSignal): Promise<FetchedItemDetails> {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=7.1`;
  const label = `ADO work item ${org}/${project}#${id}`;
  const headers = await getAdoHeaders();

  let response = await fetch(apiUrl, { headers, signal });

  if (response.status === 404 && !signal?.aborted) {
    const retryResponse = await retryAdoWithAuth(apiUrl, signal);
    if (retryResponse) { response = retryResponse; }
  }

  if (!response.ok) { handleAdoError(response, label); }

  const data = await response.json() as { fields: { 'System.Title': string; 'System.Description': string | null; 'System.TeamProject': string } };
  const teamProject = data.fields['System.TeamProject'];
  const htmlUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
  return {
    title: data.fields['System.Title'],
    notes: data.fields['System.Description'] ?? '',
    url: htmlUrl,
    externalId: `${org}/${teamProject}/${id}`,
    group: `${org}/${teamProject}`,
    providerId: 'ado-work-items',
  };
}

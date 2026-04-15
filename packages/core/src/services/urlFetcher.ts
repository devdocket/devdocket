/**
 * Fetches work item details from source URLs (GitHub PRs, ADO PRs).
 * Uses public REST APIs where possible, falling back to authenticated
 * requests when a VS Code auth session is available.
 */

import * as vscode from 'vscode';
import { type ParsedUrl } from './urlParser';
import { logger } from './logger';

export interface FetchedItemDetails {
  title: string;
  notes: string;
  url: string;
  group: string;
}

/**
 * Fetch details for a parsed source URL.
 * Throws on network or API errors with a user-friendly message.
 */
export async function fetchItemDetails(parsed: ParsedUrl): Promise<FetchedItemDetails> {
  switch (parsed.type) {
    case 'github-pr':
      return fetchGitHubPr(parsed.owner, parsed.repo, parsed.number);
    case 'ado-pr':
      return fetchAdoPr(parsed.org, parsed.project, parsed.repo, parsed.id);
  }
}

async function fetchGitHubPr(owner: string, repo: string, number: number): Promise<FetchedItemDetails> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'DevDocket-VSCode',
  };

  // Try to get a GitHub auth token for private repos
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    if (session) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
  } catch {
    logger.debug('No GitHub auth session available, using unauthenticated request');
  }

  const response = await fetch(apiUrl, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`GitHub PR not found: ${owner}/${repo}#${number}. It may be private or deleted.`);
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { title: string; body: string | null; html_url: string };

  return {
    title: `${owner}/${repo}#${number}: ${data.title}`,
    notes: data.body ?? '',
    url: data.html_url,
    group: `${owner}/${repo}`,
  };
}

async function fetchAdoPr(org: string, project: string, repo: string, id: number): Promise<FetchedItemDetails> {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}?api-version=7.1`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'DevDocket-VSCode',
  };

  // Try to get an Azure DevOps auth token
  try {
    const session = await vscode.authentication.getSession('microsoft', [
      'https://app.vssps.visualstudio.com/.default',
    ], { silent: true });
    if (session) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
  } catch {
    logger.debug('No Azure DevOps auth session available, using unauthenticated request');
  }

  const response = await fetch(apiUrl, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`ADO PR not found: ${org}/${project}/${repo}!${id}. It may be private or deleted.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`ADO authentication required for ${org}/${project}. Sign in to Azure DevOps in VS Code.`);
    }
    throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { title: string; description: string | null };
  const htmlUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;

  return {
    title: `${org}/${project}#${id}: ${data.title}`,
    notes: data.description ?? '',
    url: htmlUrl,
    group: `${org}/${project}`,
  };
}

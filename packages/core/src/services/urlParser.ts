/**
 * Parses source URLs (GitHub PRs/issues, ADO PRs/work items) into structured
 * descriptors that can be used to fetch details from their respective APIs.
 */

export interface GitHubPrUrl {
  type: 'github-pr';
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubIssueUrl {
  type: 'github-issue';
  owner: string;
  repo: string;
  number: number;
}

export interface AdoPrUrl {
  type: 'ado-pr';
  org: string;
  project: string;
  repo: string;
  id: number;
}

export interface AdoWorkItemUrl {
  type: 'ado-workitem';
  org: string;
  project: string;
  id: number;
}

export type ParsedUrl = GitHubPrUrl | GitHubIssueUrl | AdoPrUrl | AdoWorkItemUrl;

const GITHUB_PR_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;
const GITHUB_ISSUE_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\b/i;
const ADO_PR_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i;
const ADO_WORKITEM_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)\b/i;

/**
 * Parse a URL string into a structured descriptor, or return `undefined`
 * if the URL doesn't match any supported format.
 */
export function parseSourceUrl(url: string): ParsedUrl | undefined {
  const trimmed = url.trim();

  const ghPrMatch = trimmed.match(GITHUB_PR_PATTERN);
  if (ghPrMatch) {
    return {
      type: 'github-pr',
      owner: safeDecodeComponent(ghPrMatch[1]),
      repo: safeDecodeComponent(ghPrMatch[2]),
      number: parseInt(ghPrMatch[3], 10),
    };
  }

  const ghIssueMatch = trimmed.match(GITHUB_ISSUE_PATTERN);
  if (ghIssueMatch) {
    return {
      type: 'github-issue',
      owner: safeDecodeComponent(ghIssueMatch[1]),
      repo: safeDecodeComponent(ghIssueMatch[2]),
      number: parseInt(ghIssueMatch[3], 10),
    };
  }

  const adoPrMatch = trimmed.match(ADO_PR_PATTERN);
  if (adoPrMatch) {
    return {
      type: 'ado-pr',
      org: safeDecodeComponent(adoPrMatch[1]),
      project: safeDecodeComponent(adoPrMatch[2]),
      repo: safeDecodeComponent(adoPrMatch[3]),
      id: parseInt(adoPrMatch[4], 10),
    };
  }

  const adoWiMatch = trimmed.match(ADO_WORKITEM_PATTERN);
  if (adoWiMatch) {
    return {
      type: 'ado-workitem',
      org: safeDecodeComponent(adoWiMatch[1]),
      project: safeDecodeComponent(adoWiMatch[2]),
      id: parseInt(adoWiMatch[3], 10),
    };
  }

  return undefined;
}

/** Decode a percent-encoded URL path segment, returning the original on malformed input. */
function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

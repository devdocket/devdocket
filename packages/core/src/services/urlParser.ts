/**
 * Parses source URLs (GitHub PRs, ADO PRs) into structured descriptors
 * that can be used to fetch details from their respective APIs.
 */

export interface GitHubPrUrl {
  type: 'github-pr';
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

export type ParsedUrl = GitHubPrUrl | AdoPrUrl;

const GITHUB_PR_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;
const ADO_PR_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i;

/**
 * Parse a URL string into a structured descriptor, or return `undefined`
 * if the URL doesn't match any supported format.
 */
export function parseSourceUrl(url: string): ParsedUrl | undefined {
  const trimmed = url.trim();

  const ghMatch = trimmed.match(GITHUB_PR_PATTERN);
  if (ghMatch) {
    return {
      type: 'github-pr',
      owner: safeDecodeComponent(ghMatch[1]),
      repo: safeDecodeComponent(ghMatch[2]),
      number: parseInt(ghMatch[3], 10),
    };
  }

  const adoMatch = trimmed.match(ADO_PR_PATTERN);
  if (adoMatch) {
    return {
      type: 'ado-pr',
      org: safeDecodeComponent(adoMatch[1]),
      project: safeDecodeComponent(adoMatch[2]),
      repo: safeDecodeComponent(adoMatch[3]),
      id: parseInt(adoMatch[4], 10),
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

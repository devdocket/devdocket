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

const GITHUB_PR_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/;
const ADO_PR_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/;

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
      owner: ghMatch[1],
      repo: ghMatch[2],
      number: parseInt(ghMatch[3], 10),
    };
  }

  const adoMatch = trimmed.match(ADO_PR_PATTERN);
  if (adoMatch) {
    return {
      type: 'ado-pr',
      org: adoMatch[1],
      project: adoMatch[2],
      repo: adoMatch[3],
      id: parseInt(adoMatch[4], 10),
    };
  }

  return undefined;
}

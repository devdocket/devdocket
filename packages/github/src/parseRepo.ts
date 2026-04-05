import * as crypto from 'crypto';
import { logger } from './logger';

/**
 * Extracts "owner/repo" from GitHub issue/PR URLs.
 * Only trusts HTTPS URLs from known GitHub domains to prevent spoofing.
 */
export function parseRepoFromUrls(htmlUrl: string, repositoryUrl: string): string {
  if (htmlUrl.startsWith('https://github.com/')) {
    const match = htmlUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    if (match) {
      return match[1];
    }
  }

  // Fallback to parsing from repository_url (API URL)
  if (repositoryUrl.startsWith('https://api.github.com/repos/')) {
    const apiMatch = repositoryUrl.match(/repos\/([^/]+\/[^/]+)/);
    if (apiMatch) {
      return apiMatch[1];
    }
  }

  // Deterministic fallback: SHA-256 hash to avoid collisions
  logger.warn(`Could not parse repo from URLs: html_url=${htmlUrl}, repository_url=${repositoryUrl}`);
  const hash = crypto.createHash('sha256').update(repositoryUrl).digest('hex').slice(0, 12);
  return `unknown-repo-${hash}`;
}

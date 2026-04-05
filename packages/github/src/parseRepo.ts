import * as crypto from 'crypto';
import { logger } from './logger';

const GITHUB_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function buildRepoSlug(owner: string, repo: string): string | null {
  try {
    const decodedOwner = decodeURIComponent(owner);
    const decodedRepo = decodeURIComponent(repo);

    if (!decodedOwner || !decodedRepo) {
      return null;
    }

    if (!GITHUB_PATH_SEGMENT_RE.test(decodedOwner) || !GITHUB_PATH_SEGMENT_RE.test(decodedRepo)) {
      return null;
    }

    return `${decodedOwner}/${decodedRepo}`;
  } catch {
    return null;
  }
}

/**
 * Extracts "owner/repo" from GitHub issue/PR URLs.
 * Only trusts HTTPS URLs from known GitHub domains to prevent spoofing.
 * Validates path segments against GitHub-safe characters.
 */
export function parseRepoFromUrls(htmlUrl: string, repositoryUrl: string): string {
  try {
    const parsed = new URL(htmlUrl);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
      const slug = owner && repo ? buildRepoSlug(owner, repo) : null;
      if (slug) {
        return slug;
      }
    }
  } catch {
    // Invalid htmlUrl — fall through to repository_url
  }

  // Fallback to parsing from repository_url (API URL)
  try {
    const parsed = new URL(repositoryUrl);
    if (parsed.protocol === 'https:' && parsed.hostname === 'api.github.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments[0] === 'repos' && segments.length >= 3) {
        const slug = buildRepoSlug(segments[1], segments[2]);
        if (slug) {
          return slug;
        }
      }
    }
  } catch {
    // Invalid repositoryUrl — fall through to hash fallback
  }

  // Deterministic fallback: SHA-256 hash to avoid collisions
  logger.warn('Could not parse repo from URLs', { htmlUrl, repositoryUrl });
  const hash = crypto.createHash('sha256').update(repositoryUrl).digest('hex').slice(0, 12);
  return `unknown-repo-${hash}`;
}

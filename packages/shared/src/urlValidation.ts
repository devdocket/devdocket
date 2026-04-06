/**
 * Validates a single URL path segment (org name, project name, repo name).
 * Blocks path traversal (`.` / `..`), path separators (`/` / `\`),
 * and query/fragment injection (`?` / `#`). Allows other characters
 * since providers already apply encodeURIComponent when building URLs.
 */
export function isValidUrlSegment(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }
  if (!value.trim()) {
    return false;
  }
  if (value === '.' || value === '..') {
    return false;
  }
  if (value.includes('?') || value.includes('#')) {
    return false;
  }
  if (value.includes('/') || value.includes('\\')) {
    return false;
  }
  return true;
}

// GitHub owner/repo names: alphanumeric, hyphens, dots, underscores
const GITHUB_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/**
 * Validates a GitHub repo identifier in "owner/repo" format.
 * Uses a strict character set since GitHub URLs interpolate the value
 * directly without encodeURIComponent.
 */
export function isValidGitHubRepo(repo: string): boolean {
  if (!repo || typeof repo !== 'string') {
    return false;
  }
  const parts = repo.split('/');
  if (parts.length !== 2) {
    return false;
  }
  const [owner, name] = parts;
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return false;
  }
  return GITHUB_SEGMENT.test(owner) && GITHUB_SEGMENT.test(name);
}

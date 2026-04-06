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

/**
 * Validates a GitHub repo identifier in "owner/repo" format.
 * Both owner and repo segments must individually pass segment validation.
 */
export function isValidGitHubRepo(repo: string): boolean {
  if (!repo || typeof repo !== 'string') {
    return false;
  }
  const parts = repo.split('/');
  if (parts.length !== 2) {
    return false;
  }
  return isValidUrlSegment(parts[0]) && isValidUrlSegment(parts[1]);
}

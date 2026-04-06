// Pattern for a single URL path segment: alphanumeric start, then alphanumeric/hyphens/underscores/dots
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validates a single URL path segment (org name, project name, repo name).
 * Rejects empty strings, path traversal sequences, query/fragment characters,
 * slashes, and anything that doesn't match the safe character set.
 */
export function isValidUrlSegment(value: string): boolean {
  if (!value || typeof value !== 'string') {
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
  return SAFE_SEGMENT.test(value);
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

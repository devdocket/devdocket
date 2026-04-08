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

/**
 * Validates that a string is a well-formed repository slug in `owner/repo`
 * format. Both segments must contain only alphanumeric characters,
 * hyphens, underscores, or dots, and must not be empty.
 */
export function isValidRepoSlug(slug: string): boolean {
  if (!slug) {
    return false;
  }
  // Exactly one slash separating owner and repo
  const parts = slug.split('/');
  if (parts.length !== 2) {
    return false;
  }
  const [owner, repo] = parts;
  const segment = /^[a-zA-Z0-9._-]+$/;
  const isDotSegment = (value: string): boolean =>
    value === '.' || value === '..';

  if (isDotSegment(owner) || isDotSegment(repo)) {
    return false;
  }

  return segment.test(owner) && segment.test(repo);
}

/**
 * Sanitizes a single URL path segment by removing characters that could
 * cause path-traversal, query-injection, or fragment-injection issues.
 * Only alphanumeric characters, hyphens, underscores, dots, and `~` are
 * kept; everything else (including `/`, `\`, `?`, `#`) is stripped.
 * Leading dots are then removed so the result cannot be `.`, `..`, or any
 * other leading dot-segment when joined into a path or URL.
 */
export function sanitizeUrlSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9._~-]/g, '');
  return sanitized.replace(/^\.+/, '');
}

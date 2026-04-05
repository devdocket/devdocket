/**
 * Validates that a string is a well-formed GitHub-style repository slug
 * in `owner/repo` format. Both segments must contain only alphanumeric
 * characters, hyphens, underscores, or dots, and must not be empty.
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
  return segment.test(owner) && segment.test(repo);
}

/**
 * Sanitises a single URL path segment by removing characters that could
 * cause path-traversal, query-injection, or fragment-injection issues.
 * Only alphanumeric characters, hyphens, underscores, dots, and `~` are
 * kept; everything else (including `/`, `\`, `?`, `#`) is stripped.
 */
export function sanitizeUrlSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._~-]/g, '');
}

export interface RepoPattern {
  pattern: string;
  isNegation: boolean;
  regex: RegExp;
}

/**
 * Parse a multiline config string into an array of repo patterns.
 * Supports gitignore-style syntax: full-line comments (lines starting with #),
 * trailing comments (# preceded by whitespace), negation (!), and wildcards (*).
 */
export function parseRepoPatterns(config: string): RepoPattern[] {
  const lines = config.split('\n');
  const patterns: RepoPattern[] = [];

  for (const rawLine of lines) {
    // Strip trailing comments (# preceded by whitespace) and trim
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    let isNegation = false;
    let patternText = line;
    if (patternText.startsWith('!')) {
      isNegation = true;
      patternText = patternText.slice(1).trim();
    }

    if (patternText === '') {
      continue;
    }

    // Patterns must be in owner/repo format to match GitHub repo names
    if (!patternText.includes('/')) {
      continue;
    }

    const regex = patternToRegex(patternText);
    patterns.push({ pattern: isNegation ? `!${patternText}` : patternText, isNegation, regex });
  }

  return patterns;
}

/**
 * Convert a pattern string (e.g. "myorg/*") to a RegExp matching "owner/repo".
 * `*` matches any non-slash characters within a single segment.
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '[^/]*');
  return new RegExp(`^${withWildcards}$`, 'i');
}

/**
 * Determine whether a repo should be kept after applying filter patterns.
 * Semantics mirror .gitignore: positive patterns mark repos for exclusion,
 * `!` (negation) patterns re-include previously excluded repos. Last match wins.
 *
 * With no patterns, all repos are kept (no filtering).
 * Negation-only configs are a no-op (nothing to re-include from).
 *
 * @returns true if the repo passes the filter (should be kept), false if filtered out.
 */
export function matchesRepoPatterns(repo: string, patterns: RepoPattern[]): boolean {
  if (patterns.length === 0) { return true; }
  let result = true;
  for (const p of patterns) {
    if (p.regex.test(repo)) {
      result = p.isNegation;
    }
  }
  return result;
}

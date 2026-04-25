export interface RepoPattern {
  pattern: string;
  isExclusion: boolean;
  regex: RegExp;
}

/**
 * Parse a multiline config string into an array of repo patterns.
 * Supports gitignore-style syntax: comments (#), exclusions (!), wildcards (*).
 */
export function parseRepoPatterns(config: string): RepoPattern[] {
  const lines = config.split('\n');
  const patterns: RepoPattern[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    let isExclusion = false;
    let patternText = line;
    if (patternText.startsWith('!')) {
      isExclusion = true;
      patternText = patternText.slice(1).trim();
    }

    if (patternText === '') {
      continue;
    }

    const regex = patternToRegex(patternText);
    patterns.push({ pattern: line, isExclusion, regex });
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
 * Check if a repo should be included after applying filter patterns.
 * Works like .gitignore: positive patterns filter OUT (exclude) matching repos,
 * `!` patterns un-filter (re-include) them. Last match wins.
 * Returns true if the repo should be kept, false if filtered out.
 */
export function matchesRepoPatterns(repo: string, patterns: RepoPattern[]): boolean {
  if (patterns.length === 0) { return true; }
  let result = true;
  for (const p of patterns) {
    if (p.regex.test(repo)) {
      result = p.isExclusion;
    }
  }
  return result;
}

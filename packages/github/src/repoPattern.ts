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
 * Check if a repo matches the given patterns using last-match-wins semantics.
 * If no patterns match, returns false (default exclude).
 */
export function matchesRepoPatterns(repo: string, patterns: RepoPattern[]): boolean {
  if (patterns.length === 0) { return false; }
  let result = false;
  for (const p of patterns) {
    if (p.regex.test(repo)) {
      result = !p.isExclusion;
    }
  }
  return result;
}

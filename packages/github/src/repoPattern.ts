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
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '[^/]*');
  return new RegExp(`^${withWildcards}$`, 'i');
}

/**
 * Check if a repo matches the given patterns using last-match-wins semantics.
 * If no patterns match, returns false (default exclude).
 * If only exclusion patterns exist, implicitly includes all repos first.
 */
export function matchesRepoPatterns(repo: string, patterns: RepoPattern[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  const hasPositive = patterns.some(p => !p.isExclusion);

  // With only exclusion patterns, default to include (then exclude matches)
  let result = !hasPositive;

  for (const p of patterns) {
    if (p.regex.test(repo)) {
      result = !p.isExclusion;
    }
  }

  return result;
}

/**
 * Extract unique owner names from positive (non-exclusion) patterns.
 * For "myorg/somerepo" → "myorg", for "myorg/*" → "myorg".
 */
export function extractOwners(patterns: RepoPattern[]): string[] {
  const owners = new Set<string>();
  for (const p of patterns) {
    if (p.isExclusion) {
      continue;
    }
    const rawPattern = p.pattern;
    const slashIndex = rawPattern.indexOf('/');
    if (slashIndex === -1) {
      continue;
    }
    const owner = rawPattern.slice(0, slashIndex).trim();
    if (owner && !owner.includes('*')) {
      owners.add(owner);
    }
  }
  return [...owners];
}

/**
 * Check if any pattern contains a wildcard.
 */
export function hasWildcardPatterns(patterns: RepoPattern[]): boolean {
  return patterns.some(p => !p.isExclusion && p.pattern.includes('*'));
}

/**
 * Check if patterns consist only of exclusion patterns (no positive patterns).
 */
export function isNegationOnly(patterns: RepoPattern[]): boolean {
  return patterns.length > 0 && patterns.every(p => p.isExclusion);
}

/**
 * Get exact repo names from positive patterns that contain no wildcards.
 */
export function getExactRepos(patterns: RepoPattern[]): string[] {
  return patterns
    .filter(p => !p.isExclusion && !p.pattern.includes('*'))
    .map(p => p.pattern);
}

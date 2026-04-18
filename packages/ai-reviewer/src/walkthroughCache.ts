/** Maximum number of PR entries kept in the cache before evicting the oldest. */
const MAX_CACHE_ENTRIES = 20;

/** Maximum characters stored per PR entry to bound memory usage. */
const MAX_ENTRY_LENGTH = 500_000;

/**
 * In-memory cache of walkthrough findings keyed by PR URL.
 * Shared between WalkthroughParticipant (writer) and AiReviewAction (reader)
 * so that code review can incorporate walkthrough context when available.
 *
 * Uses insertion-order eviction: when the cache exceeds MAX_CACHE_ENTRIES,
 * the oldest (least-recently-written) entry is removed. Writes refresh
 * insertion order; reads do not.
 *
 * PR URLs are normalized so that query strings, fragments, and trailing
 * path segments don't cause cache misses between walkthrough and review.
 */
export class WalkthroughCache {
  private findings = new Map<string, string>();

  /**
   * Normalize PR URLs so equivalent GitHub pull request URLs map to the same
   * cache key regardless of query string, fragment, or extra path segments.
   */
  private normalizeKey(prUrl: string): string {
    try {
      const parsed = new URL(prUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (
        parsed.hostname.toLowerCase() === 'github.com' &&
        segments.length >= 4 &&
        segments[2] === 'pull'
      ) {
        const [owner, repo, , pullNumber] = segments;
        return `${parsed.protocol}//${parsed.host}/${owner}/${repo}/pull/${pullNumber}`;
      }
      // Non-GitHub URLs: strip query/fragment only
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      return `${parsed.protocol}//${parsed.host}${pathname}`;
    } catch {
      return prUrl;
    }
  }

  /** Store/replace all findings for a PR, truncating oversized content. */
  setFindings(prUrl: string, content: string): void {
    const key = this.normalizeKey(prUrl);
    // Delete first so re-insertion moves the key to the end (Map insertion order)
    this.findings.delete(key);
    this.findings.set(key, this.capContent(content));
    this.evictIfNeeded();
  }

  /**
   * Append content to existing findings for a PR (accumulates across turns),
   * truncating to keep the most recent MAX_ENTRY_LENGTH characters.
   */
  appendFindings(prUrl: string, content: string): void {
    const key = this.normalizeKey(prUrl);
    const combined = (this.findings.get(key) ?? '') + content;
    // Delete + set to refresh insertion order
    this.findings.delete(key);
    this.findings.set(key, this.capContent(combined));
    this.evictIfNeeded();
  }

  /** Retrieve findings for a PR, or undefined if none exist. */
  getFindings(prUrl: string): string | undefined {
    return this.findings.get(this.normalizeKey(prUrl));
  }

  /** Check if findings exist for a PR. */
  hasFindings(prUrl: string): boolean {
    return this.findings.has(this.normalizeKey(prUrl));
  }

  /** Clear findings for a PR. */
  clearFindings(prUrl: string): void {
    this.findings.delete(this.normalizeKey(prUrl));
  }

  /** Number of cached entries (exposed for testing). */
  get size(): number {
    return this.findings.size;
  }

  /** Cap content to the per-entry limit, keeping the most recent characters. */
  private capContent(content: string): string {
    if (content.length <= MAX_ENTRY_LENGTH) return content;
    return content.slice(content.length - MAX_ENTRY_LENGTH);
  }

  /** Remove the oldest entry when the cache exceeds the limit. */
  private evictIfNeeded(): void {
    while (this.findings.size > MAX_CACHE_ENTRIES) {
      const oldest = this.findings.keys().next().value;
      if (oldest !== undefined) {
        this.findings.delete(oldest);
      }
    }
  }
}

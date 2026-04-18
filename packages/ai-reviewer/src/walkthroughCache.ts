/** Maximum number of PR entries kept in the cache before evicting the oldest. */
const MAX_CACHE_ENTRIES = 20;

/**
 * In-memory cache of walkthrough findings keyed by PR URL.
 * Shared between WalkthroughParticipant (writer) and AiReviewAction (reader)
 * so that code review can incorporate walkthrough context when available.
 *
 * Uses LRU eviction: when the cache exceeds MAX_CACHE_ENTRIES, the oldest
 * (least-recently-inserted) entry is removed.
 */
export class WalkthroughCache {
  private findings = new Map<string, string>();

  /** Store/replace all findings for a PR. */
  setFindings(prUrl: string, content: string): void {
    // Delete first so re-insertion moves the key to the end (Map insertion order)
    this.findings.delete(prUrl);
    this.findings.set(prUrl, content);
    this.evictIfNeeded();
  }

  /** Append content to existing findings for a PR (accumulates across turns). */
  appendFindings(prUrl: string, content: string): void {
    const existing = this.findings.get(prUrl) ?? '';
    // Delete + set to refresh insertion order
    this.findings.delete(prUrl);
    this.findings.set(prUrl, existing + content);
    this.evictIfNeeded();
  }

  /** Retrieve findings for a PR, or undefined if none exist. */
  getFindings(prUrl: string): string | undefined {
    return this.findings.get(prUrl);
  }

  /** Check if findings exist for a PR. */
  hasFindings(prUrl: string): boolean {
    return this.findings.has(prUrl);
  }

  /** Clear findings for a PR. */
  clearFindings(prUrl: string): void {
    this.findings.delete(prUrl);
  }

  /** Number of cached entries (exposed for testing). */
  get size(): number {
    return this.findings.size;
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

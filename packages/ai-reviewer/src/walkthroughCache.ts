/**
 * In-memory cache of walkthrough findings keyed by PR URL.
 * Shared between WalkthroughParticipant (writer) and AiReviewAction (reader)
 * so that code review can incorporate walkthrough context when available.
 */
export class WalkthroughCache {
  private findings = new Map<string, string>();

  /** Store/replace all findings for a PR. */
  setFindings(prUrl: string, content: string): void {
    this.findings.set(prUrl, content);
  }

  /** Append content to existing findings for a PR (accumulates across turns). */
  appendFindings(prUrl: string, content: string): void {
    const existing = this.findings.get(prUrl) ?? '';
    this.findings.set(prUrl, existing + content);
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
}

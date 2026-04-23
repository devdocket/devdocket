import type { RunIdentifier, CancellationTokenLike } from './runWatcher';

/**
 * Identifier for a specific pull request parsed from a URL.
 */
export interface PRIdentifier {
  /** ID of the PR watcher that owns this PR (e.g. 'github-pr', 'ado-pr') */
  providerId: string;
  /** Provider-specific PR identifier (e.g. PR number) */
  prId: string;
  /** Human-readable display name (e.g. "PR #42: Fix login bug") */
  displayName: string;
  /** Original URL */
  url: string;
  /** Repository identifier (e.g. "owner/repo") */
  repo: string;
}

/**
 * State of a pull request.
 */
export type PRState = 'open' | 'merged' | 'closed';

/**
 * Snapshot of a PR's current state and associated pipeline runs.
 */
export interface PRRunsSnapshot {
  prState: PRState;
  runs: RunIdentifier[];
}

/**
 * A PR watcher that resolves PR URLs to their associated pipeline runs.
 * Registered via {@link DevDocketApi.registerPRWatcher}.
 */
export interface DevDocketPRWatcher {
  /** Unique identifier (e.g. 'github-pr', 'ado-pr') */
  readonly id: string;
  /** Human-readable display name */
  readonly label: string;

  /**
   * Determine whether this watcher can handle the given URL.
   * @param url - Raw URL string
   * @returns `true` if this watcher recognizes the URL as a PR
   */
  canWatch(url: string): boolean;

  /**
   * Parse a PR URL into a structured identifier.
   * @param url - Raw URL string (already validated via canWatch)
   * @returns Identifier for the PR
   * @throws If URL cannot be parsed
   */
  parsePRUrl(url: string): PRIdentifier;

  /**
   * Fetch the current PR state and its associated pipeline runs.
   * @param identifier - PR identifier returned by parsePRUrl
   * @param token - Optional cancellation token
   * @returns Current PR state and list of run identifiers
   * @throws If API call fails or PR not found
   */
  getPRRunsSnapshot(
    identifier: PRIdentifier,
    token?: CancellationTokenLike
  ): Promise<PRRunsSnapshot>;
}

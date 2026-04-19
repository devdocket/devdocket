/**
 * Overall state of a pipeline run.
 */
export type RunState = 'queued' | 'running' | 'completed';

/**
 * Conclusion of a pipeline run or job (only meaningful when state is 'completed').
 */
export type RunConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral';

/**
 * Status of an individual job within a pipeline run.
 */
export interface JobStatus {
  /** Unique name/id within the run */
  name: string;
  state: RunState;
  conclusion?: RunConclusion;
  startedAt?: string; // ISO 8601 timestamp
  completedAt?: string; // ISO 8601 timestamp
}

/**
 * Identifier for a specific pipeline run parsed from a URL.
 */
export interface RunIdentifier {
  /** ID of the watcher that owns this run (e.g. 'github-actions', 'ado-pipelines') */
  providerId: string;
  /** Provider-specific run identifier */
  runId: string;
  /** Human-readable display name (e.g. "CI Build") */
  displayName: string;
  /** Original URL */
  url: string;
  /** Optional repository identifier (e.g. "owner/repo") */
  repo?: string;
}

/**
 * Current status of a pipeline run including per-job detail.
 */
export interface RunStatus {
  overallState: RunState;
  conclusion?: RunConclusion;
  jobs: JobStatus[];
  startedAt?: string; // ISO 8601 timestamp
  completedAt?: string; // ISO 8601 timestamp
}

/**
 * A run watcher that polls for pipeline status.
 * Registered via {@link DevDocketApi.registerRunWatcher}.
 */
export interface DevDocketRunWatcher {
  /** Unique identifier (e.g. 'github-actions', 'ado-pipelines') */
  readonly id: string;
  /** Human-readable display name */
  readonly label: string;
  
  /**
   * Determine whether this watcher can handle the given URL.
   * @param url - Raw URL string
   * @returns `true` if this watcher recognizes the URL format
   */
  canWatch(url: string): boolean;
  
  /**
   * Parse a run URL into a structured identifier.
   * @param url - Raw URL string (already validated via canWatch)
   * @returns Identifier for the run
   * @throws If URL cannot be parsed
   */
  parseRunUrl(url: string): RunIdentifier;
  
  /**
   * Fetch the current status of a pipeline run.
   * @param identifier - Run identifier returned by parseRunUrl
   * @param token - Optional cancellation token
   * @returns Current status including per-job detail
   * @throws If API call fails or run not found
   */
  getRunStatus(identifier: RunIdentifier, token?: unknown): Promise<RunStatus>;
}

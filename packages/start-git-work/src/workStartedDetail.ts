import { logger } from './logger';

/**
 * Versioned schema for the `detail` field of a `'work-started'`
 * activity log entry written by this extension.
 *
 * The activity log is the source of truth for branch/worktree
 * associations (see AGENTS.md). Because the cleanup flow in
 * {@link ./gitCleanup} reads these entries by exact field name
 * — potentially weeks or months after the entry was written —
 * the shape is treated as a stable, versioned contract rather
 * than a free-form string. Any change to the payload shape
 * MUST bump the version (e.g. introduce `WorkStartedDetailV2`)
 * and update {@link decodeWorkStartedDetail} to recognise the
 * new version alongside the old one.
 *
 * All fields except `v` are optional because the writer omits
 * fields it cannot safely act on later (e.g. `branchName` is
 * omitted for PR flows when the action did not create the
 * branch, so cleanup will not delete a pre-existing user
 * branch).
 */
export interface WorkStartedDetailV1 {
  /** Schema version. */
  v: 1;
  /** Branch name created by the action, if any. */
  branchName?: string;
  /** Absolute filesystem path of the worktree created by the action, if any. */
  worktreePath?: string;
  /** Absolute filesystem path of the repository the action operated on. */
  repoPath?: string;
}

/** Input accepted by {@link encodeWorkStartedDetail} — the version tag is supplied by the encoder.
 *
 * `repoPath` is required because every code path in {@link ./startWorkAction}
 * has a known repo to record, and {@link decodeWorkStartedDetail} consumers
 * (e.g. cleanup) cannot act on an entry without it. `branchName` /
 * `worktreePath` stay optional: the PR flows intentionally omit `branchName`
 * when the action did not create the branch, and the checkout flows have no
 * worktree.
 */
export type WorkStartedDetailInput = Omit<WorkStartedDetailV1, 'v' | 'repoPath'> & { repoPath: string };

/** Decoded payload returned by {@link decodeWorkStartedDetail}.
 *
 * Always the latest known shape. When a future `WorkStartedDetailV2` is
 * introduced, {@link decodeWorkStartedDetail} is responsible for upgrading
 * older versions in place so callers can keep targeting a single type.
 */
export type WorkStartedDetail = WorkStartedDetailV1;

/** Current schema version emitted by {@link encodeWorkStartedDetail}. */
export const WORK_STARTED_DETAIL_VERSION = 1 as const;

/**
 * Encode a typed payload as the JSON string stored in the
 * `'work-started'` activity log entry's `detail` field.
 *
 * Always stamps the current schema version, so older readers
 * that lack version awareness still observe the legacy field
 * names at the top level.
 */
export function encodeWorkStartedDetail(input: Readonly<WorkStartedDetailInput>): string {
  const payload: WorkStartedDetailV1 = { v: WORK_STARTED_DETAIL_VERSION };
  if (input.branchName !== undefined) {
    payload.branchName = input.branchName;
  }
  if (input.worktreePath !== undefined) {
    payload.worktreePath = input.worktreePath;
  }
  if (input.repoPath !== undefined) {
    payload.repoPath = input.repoPath;
  }
  return JSON.stringify(payload);
}

/**
 * Decode a `'work-started'` activity log entry's `detail` field.
 *
 * - Returns `undefined` for missing, empty, malformed, or
 *   non-object JSON — callers should treat this as "no
 *   actionable info" rather than a hard error.
 * - Accepts entries written before the version tag existed
 *   (i.e. with no `v` field) by treating them as legacy
 *   payloads of the same shape. This preserves the cleanup
 *   prompt for activity logs created prior to this change.
 * - Logs a warning and returns `undefined` for entries whose
 *   `v` is present but unrecognised. This makes future
 *   schema mismatches visible in the logs instead of
 *   silently downgrading cleanup to a no-op.
 */
export function decodeWorkStartedDetail(detail: string | undefined): WorkStartedDetail | undefined {
  if (!detail) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    logger.warn('Failed to parse work-started activity detail as JSON');
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj.v;

  if (version !== undefined && version !== WORK_STARTED_DETAIL_VERSION) {
    // Single-version check today; expand to a `switch (version)` per-version
    // parser when V2 lands so each version can upgrade in place.
    logger.warn(`Unknown work-started activity detail version: ${String(version)}; cleanup will be skipped for this entry.`);
    return undefined;
  }

  const result: WorkStartedDetailV1 = { v: WORK_STARTED_DETAIL_VERSION };
  if (typeof obj.branchName === 'string') {
    result.branchName = obj.branchName;
  }
  if (typeof obj.worktreePath === 'string') {
    result.worktreePath = obj.worktreePath;
  }
  if (typeof obj.repoPath === 'string') {
    result.repoPath = obj.repoPath;
  }
  return result;
}

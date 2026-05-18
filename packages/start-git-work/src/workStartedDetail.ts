import { logger } from './logger';
import type { ActivityDetailRender } from '@devdocket/shared';

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
 * `repoPath` is required: every write site has a known repo,
 * and downstream cleanup cannot act on an entry without one.
 * The decoder enforces this and rejects v1 payloads missing it.
 * `branchName` / `worktreePath` stay optional because the PR
 * flows intentionally omit `branchName` when the action did not
 * create the branch (so cleanup will not delete a pre-existing
 * user branch), and the checkout flows have no worktree.
 */
export interface WorkStartedDetailV1 {
  /** Schema version. */
  v: 1;
  /** Absolute filesystem path of the repository the action operated on. */
  repoPath: string;
  /** Branch name created by the action, if any. */
  branchName?: string;
  /** Absolute filesystem path of the worktree created by the action, if any. */
  worktreePath?: string;
}

/** Input accepted by {@link encodeWorkStartedDetail} — the version tag is supplied by the encoder. */
export type WorkStartedDetailInput = Omit<WorkStartedDetailV1, 'v'>;

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
  const payload: WorkStartedDetailV1 = { v: WORK_STARTED_DETAIL_VERSION, repoPath: input.repoPath };
  if (input.branchName !== undefined) {
    payload.branchName = input.branchName;
  }
  if (input.worktreePath !== undefined) {
    payload.worktreePath = input.worktreePath;
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
 * - Returns `undefined` when the payload is missing the
 *   required `repoPath` field, since callers cannot act on
 *   an entry without it.
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

  if (typeof obj.repoPath !== 'string') {
    // Missing/invalid repoPath is the most common producer bug because the
    // type system already requires it on the encoder input — surfacing a
    // warning makes it easier to diagnose silent cleanup no-ops.
    logger.warn(`work-started activity detail is missing a string "repoPath" (version=${version === undefined ? 'legacy' : String(version)}); cleanup will be skipped for this entry.`);
    return undefined;
  }

  const result: WorkStartedDetailV1 = { v: WORK_STARTED_DETAIL_VERSION, repoPath: obj.repoPath };
  if (typeof obj.branchName === 'string') {
    result.branchName = obj.branchName;
  }
  if (typeof obj.worktreePath === 'string') {
    result.worktreePath = obj.worktreePath;
  }
  return result;
}

/**
 * Render a `'work-started'` activity entry's `detail` payload into a
 * display-ready representation for the editor's activity log.
 *
 * Registered with the core extension via
 * `DevDocketApi.registerActivityDetailRenderer('work-started', ...)`
 * so that the core extension does not need to understand the v1
 * schema. Returns `undefined` when the detail cannot be decoded,
 * which causes the core to fall back to plain-text rendering of
 * the raw `detail` string.
 */
export function renderWorkStartedActivityDetail(detail: string | undefined): ActivityDetailRender | undefined {
  const decoded = decodeWorkStartedDetail(detail);
  if (!decoded) {
    return undefined;
  }
  const rows: Array<{ label: string; value: string }> = [];
  if (decoded.branchName) {
    rows.push({ label: 'Branch', value: decoded.branchName });
  }
  if (decoded.worktreePath) {
    rows.push({ label: 'Worktree', value: decoded.worktreePath });
  }
  rows.push({ label: 'Repo', value: decoded.repoPath });
  return { kind: 'fields', rows };
}

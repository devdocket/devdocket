import * as fs from 'fs';
import type { WorkItem } from '../models/workItem';
import type { GitWorkData } from '../views/mainTypes';
import type { GitWorkResolverRegistry } from './gitWorkResolverRegistry';

/**
 * TTL (ms) for the worktree-existence cache. Refreshes are coarsely
 * bursty (provider refresh, watcher tick, drag/drop, state change,
 * resolver onDidChange) so a short window is enough to collapse a
 * burst into a single `existsSync` per path while still picking up
 * a user-deleted worktree within the next refresh.
 */
const WORKTREE_EXISTS_TTL_MS = 5_000;

const worktreeExistsCache = new Map<string, { value: boolean; expiresAt: number }>();

/**
 * Build the {@link GitWorkData} payload for a work item from the
 * registered git-work resolver, including a synchronous worktree-
 * existence check used to distinguish current vs. stale worktrees.
 *
 * The existence check is memoised in-process with a short TTL so
 * a refresh burst (N visible cards, plus the editor panel) doesn't
 * hammer the filesystem with one stat per render. The cache returns
 * stale entries on filesystem errors so a transient ENOENT doesn't
 * permanently mark a worktree as missing.
 *
 * Returns `undefined` when:
 *  - no registry is supplied
 *  - no resolver is registered
 *  - the resolver returns nothing
 *  - the resolver yields neither a branch nor a worktree path
 *
 * The UI uses `undefined` as the signal to hide the branch badge
 * entirely. `worktreeExists` is left undefined when there's no path
 * to test, so branch-only associations (e.g. a checkout flow without
 * a worktree) don't get incorrectly flagged as stale.
 */
export function resolveGitWorkData(
  registry: GitWorkResolverRegistry | undefined,
  item: Readonly<WorkItem>,
): GitWorkData | undefined {
  const resolved = registry?.resolve(item);
  if (!resolved) {
    return undefined;
  }
  const worktreeExists = resolved.worktreePath
    ? cachedExistsSync(resolved.worktreePath)
    : undefined;
  return {
    ...(resolved.branch ? { branch: resolved.branch } : {}),
    ...(resolved.worktreePath ? { worktreePath: resolved.worktreePath } : {}),
    ...(worktreeExists !== undefined ? { worktreeExists } : {}),
  };
}

function cachedExistsSync(path: string): boolean {
  const now = Date.now();
  const entry = worktreeExistsCache.get(path);
  if (entry && entry.expiresAt > now) {
    return entry.value;
  }
  let value: boolean;
  try {
    value = fs.existsSync(path);
  } catch {
    // Permission errors, ENAMETOOLONG, etc. — treat unreadable paths as
    // "not present" so the UI shows the stale state instead of throwing.
    value = false;
  }
  worktreeExistsCache.set(path, { value, expiresAt: now + WORKTREE_EXISTS_TTL_MS });
  return value;
}

/**
 * Test-only hook to drop cached worktree-existence entries.
 */
export function clearWorktreeExistsCache(): void {
  worktreeExistsCache.clear();
}

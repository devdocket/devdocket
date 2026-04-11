/**
 * Module-level registry of valid worktree paths managed by RepoManager.
 * Tools validate `worktreePath` inputs against this set to prevent
 * arbitrary filesystem access via LLM-provided paths.
 */
export const validWorktreePaths = new Set<string>();

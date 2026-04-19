# Decision: WorkItem Metadata Extension Pattern

**Date:** 2026-04-18  
**Author:** Fenster (Issue #264)  
**Status:** Implemented

## Context

Issue #264 required tracking git branch and worktree metadata created by the Start Git Work action so we can prompt for cleanup when items are completed.

## Decision

Extended WorkItem model with optional metadata fields (`branchName`, `worktreePath`, `repoPath`) that actions can use to store action-specific state.

### Implementation

1. **WorkItem interface:** Added optional `branchName?: string`, `worktreePath?: string`, and `repoPath?: string` fields.
2. **Update mechanism:** Created `WorkGraph.updateMetadata()` method and `devdocket.updateMetadata` command for actions to persist metadata.
3. **Action integration:** StartWorkAction calls `devdocket.updateMetadata` after creating worktree/branch, passing all three metadata fields.
4. **Cleanup hook:** `WorkGraph.transitionState()` calls `promptGitCleanup()` asynchronously when state becomes `Done`.
5. **Cleanup service:** `packages/core/src/services/gitCleanup.ts` handles worktree/branch existence checks and git operations using the stored `repoPath`.

## Rationale

- **Optional fields on WorkItem:** Keeps the interface extensible without breaking changes. Core doesn't interpret action-specific metadata.
- **Command-based updates:** Actions are separate extensions that can't import core services directly. They call public commands exposed via `vscode.commands.executeCommand`.
- **Store repoPath explicitly:** Avoids fragile regex-based inference from worktree naming conventions. The action already has the repo path when creating the worktree, so persisting it is zero additional cost.
- **Non-blocking cleanup prompt:** Transition succeeds immediately. Prompt fires asynchronously via `void promptGitCleanup()`.
- **Safety-first git operations:** Use `git branch -d` (not `-D`) to warn about unmerged changes. Remove worktree before branch (required order).
- **Branch-only cleanup:** Supports scenarios where user manually deleted the worktree but branch still exists.

## Consequences

- **Pro:** Actions can persist arbitrary metadata on WorkItems without core knowing their semantics.
- **Pro:** Cleanup is automatic but user-controlled via prompt.
- **Pro:** Non-breaking change to WorkItem interface (optional fields).
- **Pro:** No fragile naming convention coupling — repoPath is stored directly.
- **Pro:** Works even when worktree is manually deleted (branch-only cleanup).

## Alternatives Considered

1. **Store metadata in action's globalState:** Doesn't survive if action extension is uninstalled. Metadata is logically part of the work item lifecycle.
2. **Event-based approach (like PR #311):** Requires extending DevDocketApi with new events. Command-based approach is simpler and already available.
3. **Infer repo path from worktree path:** Initial implementation used regex `{repo}-issue{N}` → `{repo}`. Fragile, couples cleanup to naming convention, fails if repo name contains `-issue\d+`. Replaced with explicit storage.

## Team Impact

- This pattern can be reused by other actions that need to persist metadata (e.g., AI review feedback, test run results).
- `updateMetadata()` currently allows updating `branchName`, `worktreePath`, and `repoPath`. If more fields are needed, expand the `Pick<WorkItem, ...>` type.

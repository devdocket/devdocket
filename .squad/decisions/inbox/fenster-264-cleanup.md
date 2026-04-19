# Decision: WorkItem Metadata Extension Pattern

**Date:** 2026-04-18  
**Author:** Fenster (Issue #264)  
**Status:** Implemented

## Context

Issue #264 required tracking git branch and worktree metadata created by the Start Git Work action so we can prompt for cleanup when items are completed.

## Decision

Extended WorkItem model with optional metadata fields (`branchName`, `worktreePath`) that actions can use to store action-specific state.

### Implementation

1. **WorkItem interface:** Added optional `branchName?: string` and `worktreePath?: string` fields.
2. **Update mechanism:** Created `WorkGraph.updateMetadata()` method and `devdocket.updateMetadata` command for actions to persist metadata.
3. **Action integration:** StartWorkAction calls `devdocket.updateMetadata` after creating worktree/branch.
4. **Cleanup hook:** `WorkGraph.transitionState()` calls `promptGitCleanup()` asynchronously when state becomes `Done`.
5. **Cleanup service:** `packages/core/src/services/gitCleanup.ts` handles worktree/branch existence checks and git operations.

## Rationale

- **Optional fields on WorkItem:** Keeps the interface extensible without breaking changes. Core doesn't interpret action-specific metadata.
- **Command-based updates:** Actions are separate extensions that can't import core services directly. They call public commands exposed via `vscode.commands.executeCommand`.
- **Repo path inference:** Derive repo path from worktree path pattern (`{repo}-issue{N}`). Worktree path already known from creation.
- **Non-blocking cleanup prompt:** Transition succeeds immediately. Prompt fires asynchronously via `void promptGitCleanup()`.
- **Safety-first git operations:** Use `git branch -d` (not `-D`) to warn about unmerged changes. Remove worktree before branch (required order).

## Consequences

- **Pro:** Actions can persist arbitrary metadata on WorkItems without core knowing their semantics.
- **Pro:** Cleanup is automatic but user-controlled via prompt.
- **Pro:** Non-breaking change to WorkItem interface (optional fields).
- **Con:** Repo path inference relies on Start Git Work's naming convention. If users manually create worktrees with different names, cleanup won't find the repo.

## Alternatives Considered

1. **Store metadata in action's globalState:** Doesn't survive if action extension is uninstalled. Metadata is logically part of the work item lifecycle.
2. **Event-based approach (like PR #311):** Requires extending DevDocketApi with new events. Command-based approach is simpler and already available.
3. **Store repo path explicitly:** Would require prompting user or detecting it differently. Current approach infers from existing worktree path.

## Team Impact

- This pattern can be reused by other actions that need to persist metadata (e.g., AI review feedback, test run results).
- `updateMetadata()` only allows updating `branchName` and `worktreePath`. If more fields are needed, expand the `Pick<WorkItem, ...>` type.

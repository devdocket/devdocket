# Decision: Activity-Log-Based Cleanup Tracking

**Date:** 2026-04-18 (revised 2026-04-21)  
**Author:** Fenster (Issue #264)  
**Status:** Implemented

## Context

Issue #264 required tracking git branch and worktree metadata created by the Start Git Work action so we can prompt for cleanup when items are completed.

## Decision

Use the work item's activity log as the source of truth for branch/worktree associations instead of adding metadata fields to the WorkItem model.

### Implementation

1. **Activity types:** Added `'work-started'`, `'cleanup'`, and `'cleanup-dismissed'` to `ActivityType`.
2. **Logging work info:** StartWorkAction calls `devdocket.addActivity` with type `'work-started'` and a JSON detail string containing `{ branchName, worktreePath, repoPath }`.
3. **Reading work info:** `gitCleanup.ts` finds the most recent `'work-started'` entry in the activity log and parses its JSON detail to extract branch/worktree/repo info.
4. **Dismissal tracking:** When the user clicks "No" on the cleanup prompt, a `'cleanup-dismissed'` entry is logged. The cleanup check skips prompting if a `'cleanup-dismissed'` entry exists after the last `'work-started'` entry.
5. **Cleanup logging:** Successful cleanup logs a `'cleanup'` entry with a human-readable detail (e.g., "Removed worktree and branch feature/x").
6. **Command:** `devdocket.addActivity` registered for extensions to log activities. Validates type against known values.

## Rationale

- **Activity log as source of truth:** Avoids adding action-specific metadata fields to the WorkItem model. The activity log already exists and is designed for tracking significant events.
- **JSON detail string:** Structured data lives in the `detail` field of the `'work-started'` entry. Machine-readable while staying within the existing `ActivityLogEntry` shape.
- **Dismissal via activity entry:** Avoids a `cleanupDismissed` boolean on WorkItem. The temporal ordering of log entries naturally handles "re-arm after new work-started" — a new `'work-started'` entry after a `'cleanup-dismissed'` entry will trigger a fresh prompt.
- **Non-blocking cleanup prompt:** Transition succeeds immediately. Prompt fires asynchronously.
- **Safety-first git operations:** `git branch -d` (not `-D`) warns about unmerged changes. `--` terminators on all commands. `git show-ref --verify` for exact branch checks.

## Consequences

- **Pro:** No additional fields on WorkItem — cleaner model.
- **Pro:** Activity log provides a full audit trail of work-started/cleanup/dismissed events.
- **Pro:** Re-arming after new work-started is automatic — no need to manually reset flags.
- **Con:** Detail field is JSON, which is less human-readable than plain text for `'work-started'` entries.
- **Breaking:** Three new `ActivityType` values. Extensions with exhaustive switch must add cases.

## Alternatives Considered

1. **WorkItem metadata fields:** Original approach (PR #321 v1). Worked but added action-specific fields to the core model.
2. **Store metadata in action's globalState:** Doesn't survive if action extension is uninstalled. Metadata is logically part of the work item lifecycle.
3. **Infer repo path from worktree path:** Fragile, couples cleanup to naming convention.

# Code Review Fix Patterns

**Author:** Fenster (Extension Dev)  
**Date:** 2026-03-24  
**Status:** Applied to PR #1

## Context

Keaton's code review identified 7 Critical and 8 Important issues across the codebase. This document captures the patterns and decisions made during fixes.

## Key Patterns Established

### 1. In-Memory Cache for Storage Layer

**Decision:** JsonTaskStore now maintains a `Map<string, WorkItem>` cache as the source of truth for all operations.

**Rationale:** The previous read-modify-write pattern (`loadAll()` → modify → `writeFile()`) created race conditions where concurrent saves could overwrite each other. With the cache, all reads and writes operate on the same in-memory state, and disk is purely for persistence.

**Implementation:**
- Cache initialized on first `loadAll()` call
- `save()` and `delete()` update cache first, then persist to disk
- Cache checked before any disk read

### 2. Git Operation Safety

**Decision:** Always check preconditions before destructive git operations, and implement rollback for multi-step operations.

**Rationale:** Git failures cascade quickly. If we create a branch but the worktree creation fails, we leave orphaned branches that confuse users.

**Implementation:**
- Check if branch exists: `git branch --list <name>`
- Check if directory exists: `fs.existsSync(path)`
- On worktree failure: `git branch -D <name>` to clean up
- Use `path.join()` for cross-platform path safety

### 3. Stable External IDs

**Decision:** GitHub provider now uses `owner/repo#number` format for `externalId` instead of `html_url`.

**Rationale:** Issue URLs change when issues are transferred between repos, breaking the identity link. Repo+number is stable even across transfers.

**Trade-off:** Requires parsing `html_url` to extract owner/repo, but provides reliable long-term identity.

### 4. User-Facing Error Accumulation

**Decision:** Accumulate fetch failures across multiple repos and show a single notification summarizing all failures.

**Rationale:** Console logging is invisible to users. A single notification like "Failed to fetch issues from 3 repositories" is actionable without being spammy.

**Pattern:**
```typescript
const failures: string[] = [];
// ... fetch loop
if (failed) { failures.push(repo); }
// After loop:
if (failures.length > 0) {
  vscode.window.showWarningMessage(`Failed to fetch from ${failures.length} repositories`);
}
```

### 5. Immutable Updates

**Decision:** Clone items before applying patches in `updateItem()`: `{ ...item, ...patch }`.

**Rationale:** If `store.save()` fails, the in-memory state should remain unchanged. Mutating with `Object.assign()` then failing the save leaves inconsistent state.

**Pattern:** Always clone → update map → persist. If persist fails, the update didn't happen.

## Team Implications

- **Testing:** These patterns should be validated in tests (Hockney's domain).
- **New providers:** Follow the stable ID pattern (not URLs).
- **Storage extensions:** If we add more stores, use the in-memory cache pattern.
- **Multi-step operations:** Always consider rollback for partial failures.

## References

- PR #1 review by Keaton
- Commit: "Fix Critical and Important issues from Keaton's code review"

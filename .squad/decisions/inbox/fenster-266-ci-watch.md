# CI Pipeline Watching Feature (Issue #266)

**Date:** 2026-04-20  
**By:** Fenster  
**Context:** Implemented fire-and-forget pipeline watching for GitHub Actions

## Key Decisions

### 1. Hybrid Architecture Pattern
**Decision:** Core owns the `WatcherService` lifecycle, providers supply `DevDocketRunWatcher` interface.  
**Why:** Mirrors existing provider/action plugin patterns. Keeps polling logic centralized while provider-specific API calls are delegated. ADO Pipelines can be added later following the same pattern.

### 2. Session-Scoped Persistence
**Decision:** Watches are in-memory only, cleared on VS Code restart.  
**Why:** Design spec decision. Fire-and-forget use case doesn't need persistence. Users can re-watch by pasting URL again. Simpler implementation, no migration concerns.

### 3. API Surface Extension
**Decision:** Added optional `registerRunWatcher(watcher: DevDocketRunWatcher)` to `DevDocketApi`.  
**Why:** Non-breaking additive API change. GitHub extension checks `typeof api.registerRunWatcher === 'function'` for graceful degradation with older core versions.

### 4. Early Failure Notifications
**Decision:** Notify immediately when a job fails while run is still in progress (with running job count).  
**Why:** Design spec requirement. Configurable via `devdocket.watches.notifyOnJobFailure` (default: true) so users can opt out if too noisy.

### 5. vscode Mock Expansion
**Decision:** Added `StatusBarAlignment` enum and `createStatusBarItem()` to `packages/core/src/test/__mocks__/vscode.ts`.  
**Why:** `WatchesStatusBar` uses `vscode.StatusBarAlignment.Right`. Mock needed to support testing without real VS Code.

### 6. Concurrency Guard Pattern
**Decision:** `WatcherService.pollAllWatches()` uses `isPollInFlight` flag to skip ticks if previous poll still running.  
**Why:** Follows `BaseProvider` pattern. Prevents overlapping polls from queuing up if API calls are slow.

### 7. 3-Strike Failure Handling
**Decision:** After 3 consecutive poll failures, set `hasWarning: true`, show warning notification, stop polling that run.  
**Why:** Prevents infinite retry loops on permanent failures (auth expired, run deleted). User can dismiss or re-watch. Run stays in tree with warning icon.

## Future Considerations

- **ADO Pipelines:** Out of scope for this PR. Would implement `DevDocketRunWatcher` in `packages/ado`, parse ADO URLs, call ADO REST API.
- **Auto-watch on push:** Design spec "Out of Scope (Future)" item. Could auto-detect workflow triggers from branch push events.
- **Webhook-based updates:** Design spec future item. Would replace polling with push notifications when supported.

# CI Pipeline Watching Feature (Issue #266)

**Date:** 2026-04-20  
**By:** Fenster  
**Context:** Implemented fire-and-forget pipeline watching for GitHub Actions and Azure DevOps Pipelines

## Key Decisions

### 1. Hybrid Architecture Pattern
**Decision:** Core owns the `WatcherService` lifecycle, providers supply `DevDocketRunWatcher` interface.  
**Why:** Mirrors existing provider/action plugin patterns. Keeps polling logic centralized while provider-specific API calls are delegated. Both GitHub Actions and ADO Pipelines implemented using this pattern.

### 2. Persisted Watch Lifecycle
**Decision:** Watches are persisted to `watches.json` via `WatchStore` and restored on activation, surviving VS Code restarts. Dismissed watches are excluded on restore.  
**Why:** Users shouldn't lose active watches if VS Code restarts while a pipeline is still running. Write-queue serialization prevents file corruption. Completed/dismissed watches are cleaned up on restore.

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
**Decision:** After 3 consecutive poll failures, set `hasWarning: true` and skip that run in subsequent poll ticks.  
**Why:** Surfaces likely permanent failures (auth expired, run deleted) without removing the watch. Run stays in tree with warning icon. User can dismiss and re-watch.

## Future Considerations

- **Auto-watch on push:** Design spec "Out of Scope (Future)" item. Could auto-detect workflow triggers from branch push events.
- **Webhook-based updates:** Design spec future item. Would replace polling with push notifications when supported.

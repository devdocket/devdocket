## Summary

Expands multi-select support from Inbox-only to **all 5 tree views** in WorkCenter, allowing users to select multiple items and perform batch actions via context menus.

## Changes

### Multi-select enabled on all views (`canSelectMany: true`)
- **Inbox** (already done in earlier commits)
- **Queue**, **Focus**, **History**, **Sources** (new in this PR)

### Batch context menu actions per view

| View | Batch Actions |
|------|---------------|
| **Inbox** | Accept to Queue, Dismiss |
| **Queue** | Start (move to Focus), Archive, Delete |
| **Focus** | Complete (mark Done), Pause, Resume |
| **History** | Archive (Done items only), Delete |
| **Sources** | Accept to Queue, Dismiss |

### New commands
- `workcenter.deleteItem` — permanently removes work items (Queue + History)
- `workcenter.dismissFromSources` — dismisses items from Sources view

### Implementation details
- **`commands.ts`**: Added `resolveItemIds()` for WorkItem-based views, `resolveSourceItems()` for Sources, and `batchTransition()` helper. All modified handlers support both single-item (backward compat) and multi-item invocations.
- **`extension.ts`**: Enabled `canSelectMany: true` on all tree views. Queue drag/drop already gracefully ignores multi-drag (existing guard on line 57).
- **`historyTreeProvider.ts`**: Updated `contextValue` to distinguish `historyItem.done` vs `historyItem.archived` so the Archive menu entry only appears for Done items. Uses explicit state checks with safe fallback.
- **`package.json`**: Added new command definitions and menu entries for delete, dismiss, and archive across views.

### Tests
- Added comprehensive tests for all new multi-select operations (batch transitions, batch delete, batch accept/dismiss from Sources)
- Updated History contextValue tests to match new state-aware format
- All 1041 tests pass (`npm run build && npm run test`)

Closes #182

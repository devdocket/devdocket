## Summary

Add comprehensive unit tests for all command handlers registered in packages/core/src/commands/commands.ts.

## What's tested

- **Registration**: Verifies all expected commands are registered and disposables pushed to context
- **createItem**: Title input, whitespace trimming, cancellation
- **State transitions**: acceptToFocus, archiveItem, completeItem, blockItem, unblockItem, markWaitingOn
- **editItem**: Opens editor panel, handles missing item
- **openInBrowser**: URL resolution from work item or tree node fallback, missing URL handling
- **runAction**: Action selection via quick pick, cancellation, error handling (Error and non-Error throws)
- **moveUp / moveDown**: Delegates to workGraph.moveItem, null/undefined/missing-id guards
- **acceptFromInbox**: Creates work item with provenance, group prefix, duplicate detection, error handling
- **dismissFromInbox**: Sets dismissed state, error handling
- **acceptFromSources**: New and existing item paths, group prefix, error handling

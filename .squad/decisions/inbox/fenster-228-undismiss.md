# Un-dismiss Items from Sources (Issue #228)

**Author:** Fenster (Extension Dev)
**Date:** 2025-07-24
**Status:** Proposed (PR #262)

## Decision

Added a "Restore to Inbox" action on dismissed items in the Sources view. The action resets inbox state from `dismissed` → `unseen`, causing the item to reappear in Inbox.

## Context

Once a user dismissed an item from Inbox, it was gone forever. The item was visible in Sources with a "dismissed" label but had no recovery action. Accidental dismisses had no undo path.

## Approach

Used composite `contextValue` strings to encode the dismissed state directly into the tree item's context, enabling VS Code's `when`-clause regex matching to conditionally show/hide actions:

- Non-dismissed: `sourceItem` or `sourceItem.hasUrl` → shows Accept + Dismiss
- Dismissed: `sourceItem.dismissed` or `sourceItem.hasUrl.dismissed` → shows only Restore to Inbox

This avoids needing a separate VS Code context key and keeps the logic self-contained in the tree provider.

## Alternatives Considered

1. **VS Code context key per item** — Would require setting/clearing context keys dynamically as items change state. More complex, no real benefit for a single boolean flag.
2. **Separate "Dismissed" view** — Overkill for the recovery use case; Sources already shows dismissed items with labels.

## Impact

- No API surface changes (contextValue is internal to the tree provider)
- Existing tests unaffected — default mock state is `undefined` (unseen), so contextValue tests still pass
- Follows existing single/batch handler pattern from dismiss command

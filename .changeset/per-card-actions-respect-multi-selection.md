---
"devdocket": patch
---

When a card is part of a multi-selection (2+ items), clicking its per-card action button (Accept, Dismiss, Start, Pause, Complete, Resume, Requeue) now applies to the entire selection instead of just the one card. Previously the bulk-action toolbar at the bottom of the sidebar was the only way to act on a multi-selection — clicking a per-card button on a selected card silently dropped the rest of the selection. Per-card buttons on cards outside the selection (or with a single-item "selection") still act on that one card.

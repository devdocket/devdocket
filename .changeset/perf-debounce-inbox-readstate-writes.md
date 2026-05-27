---
"devdocket": patch
---

Debounce inbox-state and read-state persistence so rapid user actions coalesce into fewer JSON rewrites. Pending writes may remain in memory for up to 250 ms, but are explicitly flushed during shutdown, cache invalidation, and pruning.

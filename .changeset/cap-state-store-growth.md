---
"devdocket": patch
---

Cap inbox-state and read-state persistence with a shared age-based trimming helper, and apply the same bounded-storage protection to watch persistence so oversized watch snapshots only evict terminal runs and PRs.

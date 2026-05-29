---
"devdocket": patch
"@devdocket/shared": patch
---

Cap activity log detail strings at 8 KiB, truncating oversized entries with a clear marker and logging a warning so extensions cannot bloat persisted work item storage.

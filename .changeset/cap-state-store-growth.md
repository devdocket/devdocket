---
"devdocket": patch
---

Cap inbox-state and read-state persistence, evict the oldest entries when the stores grow too large, and stamp new entries with creation timestamps so oversized state can be trimmed safely.

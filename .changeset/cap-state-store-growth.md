---
"devdocket": patch
---

Cap inbox-state and read-state persistence, trim only the excess oldest entries when the stores grow too large, and stamp persisted entries with eviction timestamps so oversized state can be trimmed safely.

---
"devdocket": patch
---

Reduce CPU cost of watch persistence by collapsing the per-flush diff check into a single canonical-string comparison (no more double walks and double stringifies).

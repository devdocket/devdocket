---
"devdocket": patch
---

Reduce CPU cost of the work item editor panel by short-circuiting related-item snapshot rebuilds for items with no related refs and restricting per-provider rebuilds to the changed provider.

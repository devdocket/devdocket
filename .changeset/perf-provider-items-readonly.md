---
"devdocket": patch
---

Reduce GC pressure on the extension host by returning a cached `ReadonlyMap` from `ProviderRegistry.getAllProviderItems()` instead of cloning the outer map on every call.

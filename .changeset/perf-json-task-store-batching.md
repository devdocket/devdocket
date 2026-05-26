---
"devdocket": patch
---

Batch JsonTaskStore writes so rapid work item updates flush as a single disk write, and flush queued work item persistence during extension shutdown to avoid losing recent changes.

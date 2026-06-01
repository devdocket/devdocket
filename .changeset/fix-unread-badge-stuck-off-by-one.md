---
"devdocket": patch
---

Fix the DevDocket sidebar unread badge getting stuck off-by-one after creating a work item from a pasted URL. The Create Item from URL command registered a synthetic provider item without writing the matching inbox-state row, so the synthetic item appeared as an unseen Incoming item and inflated the badge until the workspace was reloaded. The command now marks the inbox state as `accepted` (and propagates that to canonical peers) as soon as the work item is created, mirroring the Accept from Sources flow.

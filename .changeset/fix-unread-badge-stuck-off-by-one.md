---
"devdocket": patch
---

Add regression coverage for the unread-items badge on the DevDocket sidebar so it cannot get stuck off-by-one. The badge already computes from the JOIN of inbox-state `unseen` rows and live provider items, but the test suite did not explicitly cover orphan inbox-state rows (where a provider stopped emitting `(providerId, externalId)` after the row was written) nor the user-reported sequence of marking the last unread item read and expecting the badge to reach 0. New tests lock in both invariants so a future change cannot reintroduce the off-by-one.

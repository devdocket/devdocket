---
"devdocket-github": patch
---

Reduce GitHub API request volume in auto-complete checks by batching closed-state lookups into a single GraphQL query per repository instead of one REST call per tracked item.

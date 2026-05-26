---
"@devdocket/shared": patch
"devdocket-github": patch
"devdocket-ado": patch
---

Abort in-flight provider refreshes before rebuilding GitHub and Azure DevOps providers on configuration changes so disposed providers cannot emit stale results after replacement.

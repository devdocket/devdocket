---
"@devdocket/shared": minor
"devdocket-ado": patch
"devdocket-start-git-work": patch
---

Show Start Git Work for Azure DevOps work items that lack an associated repo and explain why it is unavailable instead of silently hiding it. Add a provider capability for surfacing that explanation and debug logging when the action is filtered out so provider-data mismatches are easier to diagnose.

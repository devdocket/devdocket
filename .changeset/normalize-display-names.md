---
"devdocket": patch
"devdocket-ado": patch
"devdocket-ai-reviewer": patch
---

Normalize Marketplace `displayName` across extensions to a consistent `DevDocket <Suffix>` pattern with a plain space separator. Rename `DevDocket — Azure DevOps` to `DevDocket Azure DevOps` and `DevDocket — AI Actions` to `DevDocket AI Reviewer` (the latter also aligns the display name with the package name `devdocket-ai-reviewer` and accurately describes the extension). Output channel names, configuration section titles, user-visible warning messages, and the Azure DevOps walkthrough instruction are updated to match.

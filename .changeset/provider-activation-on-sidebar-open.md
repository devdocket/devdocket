---
"devdocket-github": patch
"devdocket-ado": patch
"devdocket-start-git-work": patch
"devdocket-ai-reviewer": patch
---

Activate provider and action extensions when the DevDocket sidebar opens, not only at VS Code startup. This ensures extensions installed mid-session (e.g., via Settings Sync) activate the first time the user opens the DevDocket sidebar instead of requiring a VS Code restart.

---
"devdocket-github": patch
"devdocket-ado": patch
"devdocket-start-git-work": patch
"devdocket-ai-reviewer": patch
---

All non-core extensions now activate only when the DevDocket sidebar is first opened, regardless of whether a workspace folder is present. The GitHub and Azure DevOps providers no longer declare `onStartupFinished`, so they no longer cascade-activate the core extension on every VS Code session. DevDocket continues to work fully in no-folder windows.

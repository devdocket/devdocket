---
"devdocket-github": patch
"devdocket-ado": patch
"devdocket-start-git-work": patch
"devdocket-ai-reviewer": patch
---

Reduce startup work in windows without a workspace folder (e.g. empty windows, `--remote` connection setup). The `start-git-work` and `ai-reviewer` action extensions now activate lazily via the DevDocket sidebar view instead of `onStartupFinished`, and all four non-core extensions short-circuit `activate()` to a no-op when no workspace folder is open, re-running activation once a folder is added. As a side effect, the GitHub and Azure DevOps providers no longer poll for items in folder-less windows — open a folder to enable the inbox.

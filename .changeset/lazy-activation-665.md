---
"devdocket-start-git-work": patch
"devdocket-ai-reviewer": patch
---

The `start-git-work` and `ai-reviewer` action extensions now activate lazily via `onView:devdocket.main` instead of `onStartupFinished`. They are pure on-demand — `start-git-work` runs when a user starts work on an item, and `ai-reviewer` runs when its review action is invoked or its `@walkthrough` chat participant is mentioned (chat participants wake on mention regardless of activation events). This avoids loading them on every VS Code session for users who never open the DevDocket sidebar. The GitHub and Azure DevOps provider extensions continue to activate at startup so background incoming-item discovery and CI/PR watchers keep running whether or not the sidebar is open.

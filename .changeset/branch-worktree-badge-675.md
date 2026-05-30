---
"@devdocket/shared": minor
"devdocket": minor
"devdocket-start-git-work": minor
---

Surface associated branch/worktree on work items: sidebar cards show a branch glyph badge and the editor header gains a branch + worktree row with an "Open Worktree" quick action. Stale worktrees (folder no longer on disk) are visually distinguished. The Start Git Work extension exposes the association via a new public `registerGitWorkResolver` API so the core extension can render the badge without parsing the private `work-started` activity-log schema.

### 2026-04-14T20-28-45Z: User directive
**By:** Matt Thalman (via Copilot)
**What:** When working on issues, always create git worktrees for each issue branch instead of switching branches on the main checkout. This enables true parallel work and prevents branch collisions. Use `git worktree add` to create worktrees per issue.
**Why:** User request — multiple agents switching branches on the same checkout is serialized and error-prone. Worktrees enable real parallelism.

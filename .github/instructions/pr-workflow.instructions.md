# PR Workflow — Use the `create-pr` Skill

When creating pull requests in an environment with [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli), **always invoke the `create-pr` skill** and follow its full multi-phase lifecycle. Do NOT hand-roll a simplified version.

## Phases

### Phase 1 — Local Loop
Rebase on `dev`, run full test suite, dispatch `superpowers:code-reviewer` agent, fix findings, re-test, and repeat until tests pass AND review is clean.

### Phase 2 — Create PR
Push branch and open PR via `gh pr create --base dev`.

### Phase 3 — Remote Loop
Run Copilot PR review via `copilot-pr-review` skill, fix comments (one commit per comment), verify CI, resolve merge conflicts. Any code change in this phase triggers a re-run of Phase 1.

## Key Rules

- **Never skip or shortcut the process.** Every PR goes through all phases.
- **Any code change re-triggers the local loop** — whether from code review, Copilot feedback, CI fix, or conflict resolution.
- **Use `superpowers:code-reviewer` agent** for code review, not a generic code-review agent.
- When working on multiple issues in parallel, each issue goes through this full cycle independently in its own worktree.
- **Default branch is `dev`.** All PRs target `dev`.

## Without Copilot CLI

Manually rebase on `dev`, run `npm run build && npm run test`, open a PR with `gh pr create --base dev`, and request review from `copilot-pull-request-reviewer`.

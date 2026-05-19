# Contributing to DevDocket

Thanks for your interest in contributing! This guide covers setting up a dev environment, the day-to-day build/test loop, and the conventions DevDocket follows for branches, commits, and pull requests.

For the comprehensive list of code conventions used throughout the codebase (testing patterns, storage contract, view conventions, etc.), see [AGENTS.md](AGENTS.md). For the maintainer-side release pipeline, see [RELEASING.md](RELEASING.md).

## Prerequisites

- [Node.js](https://nodejs.org/) **22.x** (the CI uses `actions/setup-node@v4` with `node-version: 22`)
- [VS Code](https://code.visualstudio.com/) **1.92.0** or later (1.96.0+ if you want to work on `packages/ai-reviewer`)
- [Git](https://git-scm.com/)

## Quick start

```bash
git clone https://github.com/devdocket/devdocket.git
cd devdocket
npm install
npm run build
npm run test
```

Then press **F5** inside VS Code to launch the Extension Development Host with DevDocket loaded.

## Repository layout

DevDocket is a monorepo with five VS Code extensions and one shared library:

```
packages/
├── core/              # The hub extension (UI, lifecycle, plugin API)
├── github/            # GitHub issues, mentions, PR reviews, my-PRs + Actions and PR watcher
├── ado/               # Azure DevOps work items, PR reviews, my-PRs + Pipelines and PR watcher
├── start-git-work/    # Branch + worktree action
├── ai-reviewer/       # AI code review action
└── shared/            # Shared library (BaseProvider, utilities) — published as @devdocket/shared
```

See the [Extension API documentation](docs/extension-api.md) for the contracts between `core` and the provider/action extensions.

## Building and testing

All commands run from the repo root unless noted.

| Command | What it does |
|---------|--------------|
| `npm run build` | Build every package (shared first, then the rest in parallel) |
| `npm run build:prod` | Production build (minified) |
| `npm run test` | Run vitest for every package |
| `npm run lint` | Run import-boundary check + per-package lint |
| `npm run check-boundaries` | Validate that packages don't import across forbidden boundaries |

For a single package, scope to its workspace:

```bash
cd packages/core
npm run build      # build just this package
npm run test       # test just this package
npm run watch      # rebuild on save
```

To run a single test file:

```bash
cd packages/core
npx vitest run src/test/workGraph.test.ts
```

## Branching and pull request conventions

- **Default branch is `dev`.** All feature branches branch *from* `dev` and PR back *to* `dev`. The `main` branch is managed by the release pipeline and tracks the latest released state — do not push to it directly.
- **Use merge commits, not rebase,** when syncing with `dev`: `git merge origin/dev` (not `git rebase origin/dev`). Preserves history and avoids force-push issues.
- **Commit messages and PR titles** should describe the change, not the issue. Never include the issue number in either — references go in the PR description (`Closes #N`).
- **Include a `.changeset/*.md` file** when your PR changes user-facing behavior of a publishable package. See [Releases & Changesets in AGENTS.md](AGENTS.md#releases--changesets) for the format, exact package names to use, and when a changeset is and isn't required.

## Building a `.vsix` for local install

If you want to install your build into your own VS Code (not just the Extension Development Host):

```bash
cd packages/core            # or packages/github, packages/ado, etc.
npx @vscode/vsce package
```

This produces a `.vsix` file you can install via **Extensions → ⋯ → Install from VSIX…** in VS Code.

## Regenerating the status-bar icon font

Only needed when the logomark SVG changes:

```bash
npm run build:icons -w devdocket
```

This converts `packages/core/resources/devdocket-logo-mono.svg` into the checked-in `packages/core/resources/devdocket-icons.woff` glyph used by the VS Code status bar.

## Code conventions

DevDocket has a substantial set of repository-specific conventions covering storage contracts, view patterns, testing practices, the extension API surface, etc. They're documented exhaustively in [AGENTS.md](AGENTS.md) and the topic-specific files under `.github/instructions/`. Before opening a PR with non-trivial changes, skim AGENTS.md to make sure your change aligns with how the rest of the codebase is structured.

## Submitting a pull request

1. Make sure tests pass: `npm run test`
2. Make sure the build succeeds: `npm run build`
3. Make sure linting passes: `npm run lint`
4. Push your branch and open a PR against `dev`:

   ```bash
   gh pr create --base dev
   ```

5. Wait for a maintainer to review.
6. Address feedback. Each round of review feedback should be addressed in its own commit (no force-pushes) so reviewers can see what changed.

## For maintainers

See [RELEASING.md](RELEASING.md) for the release process, Changesets workflow, and operations playbook.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT license](LICENSE).

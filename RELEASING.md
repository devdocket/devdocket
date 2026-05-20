# DevDocket Release Process

This document is the maintainer's guide to the DevDocket release pipeline. It covers how releases are produced, what the maintainer is expected to do, how to set up the underlying infrastructure, and how to recover from common failures.

For the contributor / agent perspective on how to add a `.changeset/*.md` file to a PR, see the **Releases & Changesets** section of [AGENTS.md](AGENTS.md#releases--changesets). This document picks up where that one stops — it focuses on the maintainer-side operations.

## Overview

DevDocket uses [Changesets](https://github.com/changesets/changesets) for per-package versioning and an automated tag-driven publish pipeline. The maintainer's day-to-day responsibility is to:

1. Review and merge PRs that contain a `.changeset/*.md` file describing their user-facing change.
2. Periodically review and merge the **Version Packages** PR that the Changesets bot keeps up to date on `dev`.
3. Optionally approve each per-package publish run via the `marketplace-publish` GitHub Environment.

That's it. Version numbers, changelogs, git tags, marketplace publishes, and GitHub Releases are all produced automatically from those actions.

## Pipeline at a glance

```
Contributor PR (with .changeset/*.md) merges to dev
        │
        ▼ (push to dev)
.github/workflows/changesets.yml runs
        │
        ▼ (uses changesets/action@v1)
Are there pending .changeset/*.md files?
        │
        ├── YES ── npx changeset version  ─►  Opens / updates the "Version Packages" PR against dev
        │                                       (bumps package.json versions, writes CHANGELOG.md
        │                                        entries, deletes consumed .changeset/*.md files)
        │
        └── NO ──── node scripts/create-release-tags.mjs
                        │
                        ▼
                    Fast-forward main to dev's HEAD
                    Create release tags on main (e.g., core-v0.1.0, shared-v0.1.0)
                    Push main + tags via the Changesets GitHub App
                        │
                        ▼ (each tag push triggers ONE workflow)
                    publish-shared.yml          → @devdocket/shared to GitHub Packages
                    publish-core.yml            ┐
                    publish-github.yml          │
                    publish-ado.yml             ├─► VS Code Marketplace (gated by
                    publish-start-git-work.yml  │   marketplace-publish environment)
                    publish-ai-reviewer.yml     ┘
                        │
                        ▼
                    GitHub Release created per tag with the matching CHANGELOG entry
                    (marked as a pre-release for any 0.x or `1.0.0-rc.1` style version)
```

## Day-to-day maintainer workflow

### 1. Review incoming PRs for changesets

When reviewing a PR, check that the PR includes a `.changeset/*.md` file **if and only if** the change affects user-facing behavior of a publishable package. The AGENTS.md `## Releases & Changesets` section is the canonical guide on what counts; the short version is:

- **Required:** new features, bug fixes, behavior changes, performance improvements, deprecations, API changes to any of the six publishable packages.
- **Not required:** docs, CI / workflow changes, scripts under `scripts/`, pure refactors, test-only changes, internal-only changes invisible to consumers.

A CI check emits a non-blocking warning on PRs missing a changeset. The warning is fine for legitimately changeset-less PRs — don't reject the PR just because the warning is there.

When a PR's changeset describes the change incorrectly (wrong packages, wrong bump type, misleading summary), ask the author to fix it before merging. Once merged, the changeset content becomes the changelog entry verbatim.

### 2. Watch for the Version Packages PR

Within ~1 minute of merging any PR that contained a `.changeset/*.md` file, the Changesets bot opens (or updates) a single open PR titled **"Version Packages"** against `dev`. There is always at most one such PR open at a time.

Its diff shows you **exactly what will publish** if you merge it:

- New version numbers in each affected `packages/*/package.json`
- New entries in each affected `packages/*/CHANGELOG.md`
- Deletion of the consumed `.changeset/*.md` files

You don't have to merge it immediately. The bot keeps refreshing the PR every time another `.changeset/*.md` lands on `dev`. **Treat the Version PR as a release candidate that accumulates pending changes until you're ready to ship.**

### 3. Cutting a release

When you're ready to release everything in the current Version Packages PR:

1. **Review the diff one more time.** Look for:
   - Version bumps that look wrong (e.g., a `minor` for what should be a `major`)
   - CHANGELOG entries that read poorly or expose internal implementation details that shouldn't be in a public changelog
   - Missing entries you expected to see (means a contributor forgot a changeset — usually fixable before merging by landing the missing changeset on `dev`, which refreshes the Version PR)
2. **Optionally amend the PR directly** — you can edit changelog text, adjust version bumps in `package.json`, or remove a package's entries entirely if you don't want it to ship in this release. The bot won't fight you; it only refreshes the PR when new `.changeset/*.md` files appear on `dev`.
3. **Merge the Version PR** (squash merge is fine; the merge commit is what publishes).

The moment that PR merges, the publish path of `changesets.yml` runs:

- `main` is fast-forwarded to `dev`'s HEAD (the script aborts if `main` has diverged — see [Recovery](#recovery)).
- One git tag per bumped package is created on `main` (e.g., `core-v0.1.0`, `shared-v0.1.0`).
- The Changesets GitHub App pushes `main` + tags. (The default `GITHUB_TOKEN` won't work here because tag pushes made with it don't trigger downstream workflows.)

### 4. Approve each per-package publish (if you enabled required reviewers)

Each tag push triggers a separate publish workflow run. If you configured **Required reviewers** on the `marketplace-publish` GitHub Environment (recommended), each extension publish workflow pauses at the Azure login step waiting for an approval click.

Approve each one in the GitHub Actions UI:

- https://github.com/devdocket/devdocket/actions

Each run takes ~2–4 minutes from approval to a live marketplace listing. The six workflows run in parallel — you can approve them all in quick succession without serializing.

`@devdocket/shared` is the exception: it publishes to GitHub Packages, doesn't use the `marketplace-publish` environment, and doesn't need approval — it publishes immediately on its tag push.

### 5. Verify the release

After the cascade settles, verify:

| Where | What to check |
|-------|---------------|
| https://marketplace.visualstudio.com/manage/publishers/devdocket | Each of the 5 extensions shows the new version in its listing |
| https://github.com/devdocket/devdocket/packages | `@devdocket/shared` shows the new version |
| https://github.com/devdocket/devdocket/releases | One GitHub Release per bumped package, with the CHANGELOG entry as the release notes |
| `git tag -l '*-v*' --sort=-v:refname` (local) | New tags exist for every bumped package |

## Common scenarios

### Routine release

The 99% case: contributors land changesets with their PRs over the course of a few days/weeks. You watch the Version PR's diff grow. When the pending changes feel like "enough for a release", merge it. Approve each publish run in the Actions UI. Done.

### Hotfix release (single-package urgent fix)

1. Land a feature PR with a `.changeset/*.md` that bumps only the affected package with `patch`.
2. Merge the resulting Version Packages PR immediately (don't wait to batch with other pending changesets).
3. Approve the affected publish workflow.

If other changesets are pending but you only want to ship the hotfix, you can edit the Version Packages PR directly to remove the other packages' entries before merging.

### Shipping a subset of pending changesets

This is uncommon but supported. In the Version Packages PR's diff:

1. Delete the `CHANGELOG.md` and `package.json` version updates for the packages you don't want to ship.
2. Delete the corresponding `.changeset/*.md` deletions (which restores those changesets on `dev`).
3. Commit those edits to the Version PR branch.
4. Merge.

The Changesets bot will then re-open a new Version Packages PR containing the changes you removed, ready for the next release.

## Troubleshooting

### "Cannot fast-forward main to dev"

Reported by `scripts/create-release-tags.mjs`. Means someone (or something) pushed directly to `main` since the last release, so `main` is no longer a strict ancestor of `dev`.

**Recovery:**

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
# Inspect the divergence:
git log --oneline origin/dev..main
```

Decide whether the `main`-only commits need to be preserved (rare — `main` should be effectively a mirror of released `dev`):

- **Discard them:** `git reset --hard origin/dev && git push --force-with-lease origin main`. The next release will succeed.
- **Preserve them:** merge `main` into `dev` (`git checkout dev && git merge main --no-ff && git push origin dev`). After that lands, the next push to `dev` will re-run the workflow and ff-merge will succeed because `main` is now reachable from `dev`.

This shouldn't happen if you treat `main` as bot-owned (no direct human pushes). It's worth tightening `main` branch protection to disallow direct pushes from everyone except the Changesets App.

### A publish workflow failed

Click into the failed run at https://github.com/devdocket/devdocket/actions. Common causes:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `azure/login` step fails with `AADSTS700213` or "no matching federated credential" | Federated credential subject mismatch or environment not set | Verify FC subject is exactly `repo:devdocket/devdocket:environment:marketplace-publish` |
| `vsce publish` fails with 401/403 | SP not added as Marketplace publisher member, or wrong role | Add SP as Contributor at https://marketplace.visualstudio.com/manage/publishers/devdocket |
| `vsce publish` succeeds but listing doesn't update | VS Marketplace indexing lag (rare, usually ≤5min) | Wait |
| `gh release create` fails | `contents: write` permission missing or release already exists | Check workflow `permissions:` block; releases with the same tag conflict |
| Build / test step fails | Code regression slipped through CI (shouldn't happen — `npm run test` runs in CI on every PR) | Fix on `dev`, ship a new release |

**Recovery for a failed publish:** click **Re-run failed jobs** in the Actions UI after fixing the underlying issue. The tag already exists, so the workflow picks up where it left off. Other packages' publishes (which succeeded) are unaffected — each runs in its own independent workflow.

### Version Packages PR didn't appear

The merge to `dev` ran the Changesets workflow but no Version PR was opened. Check the workflow logs at https://github.com/devdocket/devdocket/actions/workflows/changesets.yml.

Common causes:

- **`.changeset/config.json` validation error.** If `ignore`, `linked`, `fixed`, etc. reference packages not in `workspaces`, `npx changeset version` throws. Fix the config, push to `dev`, the workflow re-runs.
- **No `.changeset/*.md` files were present** (only `config.json` and `README.md`). The workflow correctly took the publish path instead — see next item.
- **`CHANGELOG.md` missing for a package with a publish workflow.** Fixed in #591 — the script now warns and skips instead of throwing.

### The bot couldn't push tags

Symptom: `changesets.yml` succeeds, but no `publish-*.yml` workflows fire. Verify:

- `CHANGESETS_APP_ID` and `CHANGESETS_APP_PRIVATE_KEY` repository secrets are set.
- The Changesets App is installed on `devdocket/devdocket`.
- The App has `contents: write`, `pull-requests: write`, `workflows: write` repository permissions.
- The App is in the `main` branch protection bypass list.
- `scripts/create-release-tags.mjs` is still creating tags via the REST API (`gh api repos/.../git/refs --method POST ...`) rather than `git push`. Tags pushed via `git push` from inside an Actions run do NOT trigger downstream tag-triggered workflows, even when the push is authenticated as a GitHub App. The REST API path is the only reliable trigger.

## Recovery

### Publishing the wrong version

The Marketplace does **not** allow un-publishing a version. You can only publish a new version that supersedes it.

If you released a broken version:

1. Land the fix on `dev` (with a `patch` changeset).
2. Merge the Version PR ASAP to ship the corrected version.
3. The broken version remains in the Marketplace's version history but won't be installed by new users (the latest is always preferred).

For truly catastrophic releases (security leak, broken installs), contact Marketplace support to deprecate the version: https://aka.ms/vsmarketplace-support.

### Deleting a tag created by mistake

```bash
git push --delete origin shared-v0.1.0
git tag -d shared-v0.1.0
```

This deletes the tag but **does not** un-publish anything that the tag's workflow already shipped. The corresponding GitHub Release also remains (delete it separately at https://github.com/devdocket/devdocket/releases).

### Rotating the Changesets GitHub App private key

If `CHANGESETS_APP_PRIVATE_KEY` is leaked or expiring:

1. Generate a new private key on the App's settings page → Private keys → Generate.
2. Update the `CHANGESETS_APP_PRIVATE_KEY` repo secret with the new `.pem` contents.
3. **Revoke the old private key** on the App settings page.

The App ID stays the same; in-flight workflow runs continue with the old key until they finish.

### Rotating Entra ID federated credential

If you need to retire the federated credential (e.g., suspected compromise of the App):

1. Register a new Entra ID App with a federated credential whose subject is `repo:devdocket/devdocket:environment:marketplace-publish`.
2. Add the new SP as a Marketplace publisher member.
3. Update repository variables `AZURE_PUBLISH_CLIENT_ID` and `AZURE_PUBLISH_TENANT_ID` to point at the new App.
4. Remove the old SP from the Marketplace publisher.
5. Delete the old App (App settings → Manage → Delete).

No code change is required — the workflow just reads the variables.

## Adding a new publishable package

If a future package (e.g., `packages/foo`) becomes publishable to the Marketplace:

1. **Pick a tag prefix** (e.g., `foo-v`) and add it to the `tagPrefixes` map in `scripts/create-release-tags.mjs`.
2. **Create `.github/workflows/publish-foo.yml`** mirroring the existing publish-*.yml files:
   - Trigger: `push: tags: ['foo-v*']`
   - Calls `./.github/workflows/_publish-vscode-extension.yml` with `package-directory: packages/foo`, `package-title: <human title>`, `tag-prefix: foo-v`
   - Grants `permissions: contents: write, id-token: write`
3. **Add the new tag pattern (`foo-v*`) to the `marketplace-publish` environment's deployment-tag restrictions.**
4. **Add an entry for `foo` to the publish package list in [AGENTS.md](../AGENTS.md#releases--changesets).**
5. Land a `.changeset/*.md` for `packages/foo` and let the next release cut its first published version.

No federated credential changes needed — the environment-based subject covers any workflow scoped to `marketplace-publish`.

## Reference

| File / location | What it does |
|-----------------|--------------|
| `.changeset/config.json` | Changesets configuration (changelog format, base branch, internal dependency policy) |
| `.changeset/*.md` | Pending change descriptions waiting to ship in the next Version Packages PR |
| `packages/*/CHANGELOG.md` | Per-package changelog — written by `changeset version`, never edited manually |
| `.github/workflows/changesets.yml` | Triggers on push to `dev`; opens Version PR or runs publish script |
| `scripts/create-release-tags.mjs` | The publish script — ff-merges main, creates tags, pushes |
| `scripts/extract-changelog.mjs` | Helper that reads the latest CHANGELOG entry for a release's notes |
| `.github/workflows/_publish-vscode-extension.yml` | Reusable workflow that builds, packages, OIDC-authenticates, and publishes one extension |
| `.github/workflows/publish-*.yml` | Per-package tag-triggered wrappers around the reusable workflow |
| `.github/workflows/publish-shared.yml` | The shared library's GitHub Packages publish (separate path from the extensions) |
| `AGENTS.md` § Releases & Changesets | The contributor/agent-side rules for adding changesets to PRs |
# DevDocket AI Reviewer

## 0.1.3

### Patch Changes

- [#657 Propagate AI reviewer worktree cancellation](https://github.com/devdocket/devdocket/pull/657) [`c8b9862`](https://github.com/devdocket/devdocket/commit/c8b98624e59da8e2bb4c2353b063797e66c85a6a) - Forward AI reviewer cancellation into git worktree setup so cancelled reviews stop clone, fetch, and worktree subprocesses promptly and record where cancellation occurred.

- [#687 Fix empty AI review output handling](https://github.com/devdocket/devdocket/pull/687) [`591ff88`](https://github.com/devdocket/devdocket/commit/591ff8893bc1aa5c28dd8d0ea7ee39fedabb69a1) - Ensure AI code reviews and related AI Reviewer flows always request a substantive body and surface a clear warning instead of opening a header-only response when the language model returns no content.

- [#653 Cancel abandoned auth retries before prompting users](https://github.com/devdocket/devdocket/pull/653) [`b7b0c5e`](https://github.com/devdocket/devdocket/commit/b7b0c5ec5e5c7e315d6bcc3796d18b6b43030831) - Prevent background and cancelled auth flows from reusing orphaned VS Code authentication sessions, and only prompt interactively after a silent session check for user-initiated refreshes and PR actions.

- [#690 Fix walkthrough final file follow-ups](https://github.com/devdocket/devdocket/pull/690) [`8ecb747`](https://github.com/devdocket/devdocket/commit/8ecb747522bb8463b72804c32d9bef7afac0a94b) - Keep walkthrough "Go deeper" follow-ups from consuming remaining file progress when the model re-signals walkthrough without a matching file path.

- [#690 Fix walkthrough final file follow-ups](https://github.com/devdocket/devdocket/pull/690) [`8ecb747`](https://github.com/devdocket/devdocket/commit/8ecb747522bb8463b72804c32d9bef7afac0a94b) - Fix the PR walkthrough follow-up buttons so the final presented file offers wrap-up actions instead of another next-file step, even when the model reports the regular walkthrough phase.

- [#686 Include licenses in extension packages](https://github.com/devdocket/devdocket/pull/686) [`ed9d196`](https://github.com/devdocket/devdocket/commit/ed9d1965c766ccb2f7d9b67288ce709efce3d06b) - Generate each extension VSIX's LICENSE from the repository root license at package time so shipped artifacts carry the license without committing duplicate copies.

- [#648 Sanitize AI reviewer GitHub worktree directories](https://github.com/devdocket/devdocket/pull/648) [`cc6cc2d`](https://github.com/devdocket/devdocket/commit/cc6cc2d40961758838737c034aecf16c526fd743) - Sanitize GitHub worktree repo directories the same way they are cleaned up so AI Reviewer worktrees stay consistent for repository names with unsafe path characters.

- Updated dependencies [[`f03b402`](https://github.com/devdocket/devdocket/commit/f03b40203818b95cc3a33379af328814ed04892c), [`1ec2cab`](https://github.com/devdocket/devdocket/commit/1ec2caba27ca7bbfc31de5e4dbe23b8443762540), [`b7b0c5e`](https://github.com/devdocket/devdocket/commit/b7b0c5ec5e5c7e315d6bcc3796d18b6b43030831), [`614a27a`](https://github.com/devdocket/devdocket/commit/614a27a63cf4fd88a4dac2c7649e74a03cdbf28a), [`7187dc7`](https://github.com/devdocket/devdocket/commit/7187dc7dede610ebc9bd4fae1ac95060550add47), [`c52f74c`](https://github.com/devdocket/devdocket/commit/c52f74c02f096099f3e82ce651a5e72f45e11f50), [`22e4496`](https://github.com/devdocket/devdocket/commit/22e4496d38f1f027e71f1665a1995491c7ef2fd9)]:
  - @devdocket/shared@0.3.0

## 0.1.2

### Patch Changes

- [#631 Activate provider extensions when DevDocket sidebar opens](https://github.com/devdocket/devdocket/pull/631) [`3b5342d`](https://github.com/devdocket/devdocket/commit/3b5342d786da9ede1d22f708dc781eb7049426d4) - Activate provider and action extensions when the DevDocket sidebar opens, not only at VS Code startup. This ensures extensions installed mid-session (e.g., via Settings Sync) activate the first time the user opens the DevDocket sidebar instead of requiring a VS Code restart.

- Updated dependencies [[`3789ea0`](https://github.com/devdocket/devdocket/commit/3789ea05145bb8b1e5c037cb73375fe716e75db0)]:
  - @devdocket/shared@0.2.0

## 0.1.1

### Patch Changes

- [#604](https://github.com/devdocket/devdocket/pull/604) [`35c88ed`](https://github.com/devdocket/devdocket/commit/35c88edea06fce94eae8494b10ec19e9e5b5f1af) Thanks [@mthalman](https://github.com/mthalman)! - Add a 128×128 Marketplace icon to each publishable extension so the VS Code Marketplace listings, search results, and Extensions sidebar render a branded icon instead of the generic placeholder.

- [#605](https://github.com/devdocket/devdocket/pull/605) [`a38f8ad`](https://github.com/devdocket/devdocket/commit/a38f8adb00d31d98a31a875b1ce3dee06189e6ce) Thanks [@mthalman](https://github.com/mthalman)! - Complete Marketplace metadata for each publishable extension: add `repository`, `bugs`, `homepage`, `keywords`, `galleryBanner`, `preview: true`, and reassign `categories` from `Other` to descriptive Marketplace categories so listings show working repo/issues/learn-more links, brand-colored headers, a Preview badge, and surface under category filters.

- [#603](https://github.com/devdocket/devdocket/pull/603) [`79f491f`](https://github.com/devdocket/devdocket/commit/79f491f745e82a9dbd8c8d3ea0a3a4b9d1b17c64) Thanks [@mthalman](https://github.com/mthalman)! - Add Marketplace listing READMEs for each publishable extension so the VS Code Marketplace pages render meaningful content describing what the extension does, requirements, getting started steps, and key configuration. Configuration sections are kept brief and defer to the auto-generated Settings section of the Features tab for the full setting list. Verbose multi-line configuration descriptions in `devDocketGithub.filteredRepos`, `devDocketAdo.projects`, and `devDocketStartGitWork.commands` are converted to `markdownDescription` so they render with proper code blocks and inline formatting on the Marketplace listing and the VS Code Settings UI.

- [#606](https://github.com/devdocket/devdocket/pull/606) [`29d3039`](https://github.com/devdocket/devdocket/commit/29d30395c42ba091ea16995dd843c7aaf359b9ea) Thanks [@mthalman](https://github.com/mthalman)! - Normalize Marketplace `displayName` across extensions to a consistent `DevDocket <Suffix>` pattern with a plain space separator. Rename `DevDocket — Azure DevOps` to `DevDocket Azure DevOps` and `DevDocket — AI Actions` to `DevDocket AI Reviewer` (the latter also aligns the display name with the package name `devdocket-ai-reviewer` and accurately describes the extension). Output channel names, configuration section titles, user-visible warning messages, and the Azure DevOps walkthrough instruction are updated to match.

## 0.1.0

### Minor Changes

- [#593](https://github.com/devdocket/devdocket/pull/593) [`a88c1ef`](https://github.com/devdocket/devdocket/commit/a88c1ef53be6958d4bb662a51b7694bc8918e0b2) Thanks [@mthalman](https://github.com/mthalman)! - Initial public release.

### Patch Changes

- Updated dependencies [[`a88c1ef`](https://github.com/devdocket/devdocket/commit/a88c1ef53be6958d4bb662a51b7694bc8918e0b2)]:
  - @devdocket/shared@0.1.0

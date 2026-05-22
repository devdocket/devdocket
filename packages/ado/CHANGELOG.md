# DevDocket Azure DevOps

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

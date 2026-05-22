# DevDocket

## 0.2.0

### Minor Changes

- [#619 Improve startup experience for new users and standardize "recognized" spelling](https://github.com/devdocket/devdocket/pull/619) [`ee77f2c`](https://github.com/devdocket/devdocket/commit/ee77f2cc08b5562951d6032d52e05bb4940885c6) - Improve the new-user startup experience. The **My Work** tab now shows the same friendly onboarding empty state as the **Sources** tab — both empty states now offer "Create Work Item", "Browse Provider Extensions", and "Open Walkthrough" buttons — instead of a bare "No items yet" placeholder on My Work. The walkthrough's extensions link and the new button both open the Extensions view filtered to the DevDocket publisher. The "No provider recognized this URL" error (spelling updated from the previous British form) now includes a "Browse Provider Extensions" action that opens the same filtered view, and a new `devdocket.browseProviderExtensions` command is registered.

- [#628 Add merge-on-write and cross-window state propagation](https://github.com/devdocket/devdocket/pull/628) [`e8ba308`](https://github.com/devdocket/devdocket/commit/e8ba3081a3d9f265732eae4be162a7b3ad782f7e) - Add merge-on-write to work items, inbox state, read state, and provider labels plus cross-window change propagation via a version file, preventing silent data loss when multiple VS Code windows write concurrently.

### Patch Changes

- [#627 Throttle provider refreshes in unfocused windows](https://github.com/devdocket/devdocket/pull/627) [`3789ea0`](https://github.com/devdocket/devdocket/commit/3789ea05145bb8b1e5c037cb73375fe716e75db0) - Throttle background provider refreshes when the VS Code window is unfocused so background windows still poll for new notifications while reducing redundant API calls across multiple windows.

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

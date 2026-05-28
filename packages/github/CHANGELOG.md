# DevDocket GitHub

## 0.2.0

### Minor Changes

- [#660 Add GitHub SSO recovery prompts](https://github.com/devdocket/devdocket/pull/660) [`1ec2cab`](https://github.com/devdocket/devdocket/commit/1ec2caba27ca7bbfc31de5e4dbe23b8443762540) - Add a shared recoverable-error contract so providers can supply recovery actions without teaching the core extension about provider-specific failures, and use it for GitHub SSO authorization prompts and deduplicated background refresh notifications.

- [#671 Add rate-limit backoff for watches and refreshes](https://github.com/devdocket/devdocket/pull/671) [`7187dc7`](https://github.com/devdocket/devdocket/commit/7187dc7dede610ebc9bd4fae1ac95060550add47) - Add shared polling backoff support and teach DevDocket watches/providers to honor throttling signals like Retry-After, GitHub rate-limit resets, and temporary upstream outages before retrying.

- [#661 Unify URL-resolve results with ProviderItem metadata](https://github.com/devdocket/devdocket/pull/661) [`22e4496`](https://github.com/devdocket/devdocket/commit/22e4496d38f1f027e71f1665a1995491c7ef2fd9) - Unify provider URL resolution with ProviderItem so imported items keep provider capabilities and metadata, enable Start Git Work for GitHub URL-imported issues and pull requests, and replace `ResolvedItem` / `ProviderResolvedItem` with `ResolvedUrlResult` for the registry-level pairing of `providerId` plus resolved item. Provider `resolveUrl` implementations now return `ProviderItem` directly, while `ProviderRegistry.resolveUrl` returns `ResolvedUrlResult`. Also fixes Azure DevOps pull requests imported by URL so Start Git Work can use provider-supplied git metadata across reloads, and accepts valid Azure DevOps HTTPS clone URLs during PR checkout.

Migration notes: remove `ResolvedItem` and `ProviderResolvedItem` imports, update provider `resolveUrl` implementations to return `Promise<ProviderItem | undefined>`, and if you consume registry-level URL resolution use the new exported `ResolvedUrlResult` shape: `{ providerId, item }`. Ensure your resolved `ProviderItem` still sets `url` so imported work items link back to the source. Notes seeding for URL-created work items now comes from `item.description` in the core URL-import flow instead of a dedicated type field, so providers can no longer return a distinct notes seed separate from `description`.

### Patch Changes

- [#653 Cancel abandoned auth retries before prompting users](https://github.com/devdocket/devdocket/pull/653) [`b7b0c5e`](https://github.com/devdocket/devdocket/commit/b7b0c5ec5e5c7e315d6bcc3796d18b6b43030831) - Prevent background and cancelled auth flows from reusing orphaned VS Code authentication sessions, and only prompt interactively after a silent session check for user-initiated refreshes and PR actions.

- [#674 Abort stale provider refreshes during reconfiguration](https://github.com/devdocket/devdocket/pull/674) [`614a27a`](https://github.com/devdocket/devdocket/commit/614a27a63cf4fd88a4dac2c7649e74a03cdbf28a) - Abort in-flight provider refreshes before rebuilding GitHub and Azure DevOps providers on configuration changes so disposed providers cannot emit stale results after replacement.

- [#686 Include licenses in extension packages](https://github.com/devdocket/devdocket/pull/686) [`ed9d196`](https://github.com/devdocket/devdocket/commit/ed9d1965c766ccb2f7d9b67288ce709efce3d06b) - Generate each extension VSIX's LICENSE from the repository root license at package time so shipped artifacts carry the license without committing duplicate copies.

- [#721 perf: batch closed-state lookups in GitHub auto-complete via GraphQL](https://github.com/devdocket/devdocket/pull/721) [`9c43d3f`](https://github.com/devdocket/devdocket/commit/9c43d3ff4f5e4b6f97ec4325657a43906b5230d7) - Reduce GitHub API request volume in auto-complete checks by batching closed-state lookups into a single GraphQL query per repository instead of one REST call per tracked item.

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

## 0.1.0

### Minor Changes

- [#593](https://github.com/devdocket/devdocket/pull/593) [`a88c1ef`](https://github.com/devdocket/devdocket/commit/a88c1ef53be6958d4bb662a51b7694bc8918e0b2) Thanks [@mthalman](https://github.com/mthalman)! - Initial public release.

### Patch Changes

- Updated dependencies [[`a88c1ef`](https://github.com/devdocket/devdocket/commit/a88c1ef53be6958d4bb662a51b7694bc8918e0b2)]:
  - @devdocket/shared@0.1.0

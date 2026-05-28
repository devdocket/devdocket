# DevDocket

## 0.4.0

### Minor Changes

- [#671 Add rate-limit backoff for watches and refreshes](https://github.com/devdocket/devdocket/pull/671) [`7187dc7`](https://github.com/devdocket/devdocket/commit/7187dc7dede610ebc9bd4fae1ac95060550add47) - Add shared polling backoff support and teach DevDocket watches/providers to honor throttling signals like Retry-After, GitHub rate-limit resets, and temporary upstream outages before retrying.

- [#673 Surface Start Git Work earlier in the work item flow](https://github.com/devdocket/devdocket/pull/673) [`c52f74c`](https://github.com/devdocket/devdocket/commit/c52f74c02f096099f3e82ce651a5e72f45e11f50) - Show Start Git Work earlier in the DevDocket flow by surfacing it for Ready to Start items and directly in Incoming previews.

### Patch Changes

- [#658 Record before and after values in updated activity log entries](https://github.com/devdocket/devdocket/pull/658) [`0371af2`](https://github.com/devdocket/devdocket/commit/0371af2379c8da498c8f20fb5746935aeef0d281) - Record per-field before/after values for updated activity log entries and render structured diffs in the work item editor. Provider-synced description updates now use a generic changed marker to avoid storing large mirrored bodies in the activity log.

- [#660 Add GitHub SSO recovery prompts](https://github.com/devdocket/devdocket/pull/660) [`1ec2cab`](https://github.com/devdocket/devdocket/commit/1ec2caba27ca7bbfc31de5e4dbe23b8443762540) - Add a shared recoverable-error contract so providers can supply recovery actions without teaching the core extension about provider-specific failures, and use it for GitHub SSO authorization prompts and deduplicated background refresh notifications.

- [#656 Cap inbox and read state store growth](https://github.com/devdocket/devdocket/pull/656) [`4301bc1`](https://github.com/devdocket/devdocket/commit/4301bc173430e99e553f0a2dddb5e17a1cd0f253) - Cap inbox-state and read-state persistence with a shared age-based trimming helper, and apply the same bounded-storage protection to watch persistence so oversized watch snapshots only evict terminal runs and PRs.

- [#715 fix: refresh activity log in open work item editor when entries are appended](https://github.com/devdocket/devdocket/pull/715) [`db7a120`](https://github.com/devdocket/devdocket/commit/db7a120692c2e3f168eb9edc6e10e67c26e85cf0) - Fix activity log section in the work item editor not updating live when new entries are appended; previously required closing and reopening the editor.

- [#653 Cancel abandoned auth retries before prompting users](https://github.com/devdocket/devdocket/pull/653) [`b7b0c5e`](https://github.com/devdocket/devdocket/commit/b7b0c5ec5e5c7e315d6bcc3796d18b6b43030831) - Prevent background and cancelled auth flows from reusing orphaned VS Code authentication sessions, and only prompt interactively after a silent session check for user-initiated refreshes and PR actions.

- [#650 Persist dismissed PR watches across restarts](https://github.com/devdocket/devdocket/pull/650) [`5a2fe41`](https://github.com/devdocket/devdocket/commit/5a2fe4143adeddc48c545110ef032ba94a424e13) - Keep dismissed pull request watches hidden across VS Code restarts so auto-watch does not recreate them after you close and reopen the window.

- [#649 Bundle codicons for the CI watch panel](https://github.com/devdocket/devdocket/pull/649) [`b1660a4`](https://github.com/devdocket/devdocket/commit/b1660a4df4e4e8412ca19584a06c845a90214332) - Bundle the CI Watches panel codicon assets into the extension so watch action icons render correctly in marketplace installs. This also removes the activation warning about missing `@vscode/codicons` files.

- [#686 Include licenses in extension packages](https://github.com/devdocket/devdocket/pull/686) [`ed9d196`](https://github.com/devdocket/devdocket/commit/ed9d1965c766ccb2f7d9b67288ce709efce3d06b) - Generate each extension VSIX's LICENSE from the repository root license at package time so shipped artifacts carry the license without committing duplicate copies.

- [#670 Parallelize run and PR watcher polling](https://github.com/devdocket/devdocket/pull/670) [`28aec9f`](https://github.com/devdocket/devdocket/commit/28aec9f5db36920d1eb285eb6a69e126ad7b0625) - Poll CI runs and PR watches concurrently so large watch lists refresh faster without waiting for each provider call to finish in series.

- [#722 perf: batch "Accept All" inbox operations](https://github.com/devdocket/devdocket/pull/722) [`06bdd12`](https://github.com/devdocket/devdocket/commit/06bdd124165a8f0fcc47431fef5cfa11b76c7190) - Improve "Accept All" performance on the Incoming tier by batching inbox accepts into a single work-graph transaction with one persist and one webview refresh.

- [#720 perf: O(1) CI badge lookup during sidebar refresh](https://github.com/devdocket/devdocket/pull/720) [`211b536`](https://github.com/devdocket/devdocket/commit/211b53697b99f13fc2a61f8f5f353b240827a3e3) - Improve sidebar refresh performance by building a URL→watch index once per refresh instead of scanning all watches per card.

- [#693 Debounce inbox and read state writes](https://github.com/devdocket/devdocket/pull/693) [`a0285eb`](https://github.com/devdocket/devdocket/commit/a0285eb83eba455c9a918ee9837faaa045c1ad22) - Debounce inbox-state and read-state persistence so rapid user actions coalesce into fewer JSON rewrites. Pending writes may remain in memory for up to 250 ms, but are explicitly flushed during shutdown, cache invalidation, and pruning.

- [#691 Debounce watch persistence writes](https://github.com/devdocket/devdocket/pull/691) [`402e6ac`](https://github.com/devdocket/devdocket/commit/402e6ac67a2865d36e43699e7209647b3d98bc35) - Debounce watch persistence writes and skip saves when only poll timestamps change, reducing repeated full-envelope rewrites during CI polling.

- [#692 Filter editor provider refreshes](https://github.com/devdocket/devdocket/pull/692) [`de8cf3a`](https://github.com/devdocket/devdocket/commit/de8cf3afaf075990b619630d1bbca107baf3bf3b) - Reduce unnecessary editor panel refreshes by filtering provider-item updates to the work item currently shown in the editor.

- [#672 Batch JsonTaskStore persistence writes](https://github.com/devdocket/devdocket/pull/672) [`81c94d6`](https://github.com/devdocket/devdocket/commit/81c94d6f51503c97c4aba68d8d3f430c3cb3f7ad) - Batch JsonTaskStore writes so rapid work item updates flush as a single disk write, and flush queued work item persistence during extension shutdown to avoid losing recent changes.

- [#689 Memoize related items index](https://github.com/devdocket/devdocket/pull/689) [`dbad0b0`](https://github.com/devdocket/devdocket/commit/dbad0b0076f5bb0f58ebbf7213864f793a28539b) - Memoize the related-items index across unchanged sidebar refreshes and skip unnecessary reverse related-item scans when no pull request refs are present.

- [#716 perf: stop cloning ProviderRegistry items map on every getter call](https://github.com/devdocket/devdocket/pull/716) [`0f528e4`](https://github.com/devdocket/devdocket/commit/0f528e4c6c81ceb04171d6e1e5041bfe260e9f96) - Reduce GC pressure on the extension host by returning a cached `ReadonlyMap` from `ProviderRegistry.getAllProviderItems()` instead of cloning the outer map on every call.

- [#717 perf: short-circuit related-item snapshot rebuild in work item editor](https://github.com/devdocket/devdocket/pull/717) [`b1c4dd4`](https://github.com/devdocket/devdocket/commit/b1c4dd479740a8561fa5c8408977c5f732c990c8) - Reduce CPU cost of the work item editor panel by short-circuiting related-item snapshot rebuilds for items with no related refs and restricting per-provider rebuilds to the changed provider.

- [#719 perf: send targeted CI-badge patches on watch-only sidebar refresh](https://github.com/devdocket/devdocket/pull/719) [`97592d3`](https://github.com/devdocket/devdocket/commit/97592d3b17a796023e3077e01e10433e5269b38c) - Reduce sidebar refresh cost on CI watch updates by sending targeted CI-badge patches instead of full tier/sources snapshots.

- [#688 Reduce watch panel refreshes](https://github.com/devdocket/devdocket/pull/688) [`ca49148`](https://github.com/devdocket/devdocket/commit/ca49148e050366de533358ca32206f23f38468ad) - Avoid refreshing the CI Watches panel when provider item lists change, while preserving Open in DevDocket links to matching Sources PRs.

- [#718 perf: collapse watch-persistence diff into single canonical-string comparison](https://github.com/devdocket/devdocket/pull/718) [`95e1fc3`](https://github.com/devdocket/devdocket/commit/95e1fc3bb3ab9b9a7d2b911417e666f5567779db) - Reduce CPU cost of watch persistence by collapsing the per-flush diff check into a single canonical-string comparison (no more double walks and double stringifies).

- [#661 Unify URL-resolve results with ProviderItem metadata](https://github.com/devdocket/devdocket/pull/661) [`22e4496`](https://github.com/devdocket/devdocket/commit/22e4496d38f1f027e71f1665a1995491c7ef2fd9) - Unify provider URL resolution with ProviderItem so imported items keep provider capabilities and metadata, enable Start Git Work for GitHub URL-imported issues and pull requests, and replace `ResolvedItem` / `ProviderResolvedItem` with `ResolvedUrlResult` for the registry-level pairing of `providerId` plus resolved item. Provider `resolveUrl` implementations now return `ProviderItem` directly, while `ProviderRegistry.resolveUrl` returns `ResolvedUrlResult`. Also fixes Azure DevOps pull requests imported by URL so Start Git Work can use provider-supplied git metadata across reloads, and accepts valid Azure DevOps HTTPS clone URLs during PR checkout.

Migration notes: remove `ResolvedItem` and `ProviderResolvedItem` imports, update provider `resolveUrl` implementations to return `Promise<ProviderItem | undefined>`, and if you consume registry-level URL resolution use the new exported `ResolvedUrlResult` shape: `{ providerId, item }`. Ensure your resolved `ProviderItem` still sets `url` so imported work items link back to the source. Notes seeding for URL-created work items now comes from `item.description` in the core URL-import flow instead of a dedicated type field, so providers can no longer return a distinct notes seed separate from `description`.

- Updated dependencies [[`f03b402`](https://github.com/devdocket/devdocket/commit/f03b40203818b95cc3a33379af328814ed04892c), [`1ec2cab`](https://github.com/devdocket/devdocket/commit/1ec2caba27ca7bbfc31de5e4dbe23b8443762540), [`b7b0c5e`](https://github.com/devdocket/devdocket/commit/b7b0c5ec5e5c7e315d6bcc3796d18b6b43030831), [`614a27a`](https://github.com/devdocket/devdocket/commit/614a27a63cf4fd88a4dac2c7649e74a03cdbf28a), [`7187dc7`](https://github.com/devdocket/devdocket/commit/7187dc7dede610ebc9bd4fae1ac95060550add47), [`c52f74c`](https://github.com/devdocket/devdocket/commit/c52f74c02f096099f3e82ce651a5e72f45e11f50), [`22e4496`](https://github.com/devdocket/devdocket/commit/22e4496d38f1f027e71f1665a1995491c7ef2fd9)]:
  - @devdocket/shared@0.3.0

## 0.3.0

### Minor Changes

- [#644 Migrate user-intent stores to file-backed storage for cross-window sync](https://github.com/devdocket/devdocket/pull/644) [`a3e46a3`](https://github.com/devdocket/devdocket/commit/a3e46a3a9c8f80e8988f1569bffc38dee2d84fea) - Migrate work items, inbox state, read state, and watches from globalState to file-backed storage so cross-window reloads can read fresh data from disk.

### Patch Changes

- [#643 Wait for webview to signal ready before posting initial sidebar data](https://github.com/devdocket/devdocket/pull/643) [`0822bbb`](https://github.com/devdocket/devdocket/commit/0822bbb85afe44adfa6225b266d7dc09d5a29c93) - Wait for the sidebar webview to signal it is ready before posting initial data, with a fallback timeout so first-open content still appears if the ready message never arrives.

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

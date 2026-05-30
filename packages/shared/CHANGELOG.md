# @devdocket/shared

## 0.4.0

### Minor Changes

- [#726 Add contractVersion to DevDocket extension API](https://github.com/devdocket/devdocket/pull/726) [`9985696`](https://github.com/devdocket/devdocket/commit/99856964af8acd15f6eea7ada7729064c5f92361) - Expose `DevDocketApi.contractVersion` and a `CONTRACT_VERSION` constant on `@devdocket/shared` so provider and action extensions can perform runtime compatibility checks. Providers and actions may declare an optional `minContractVersion`; when the core extension's contract version is lower, registration is skipped with a warning (and a no-op disposable is returned) instead of throwing, allowing host extensions to degrade gracefully against older DevDocket cores.

- [#731 Surface associated branch and worktree on work items](https://github.com/devdocket/devdocket/pull/731) [`fb74f3d`](https://github.com/devdocket/devdocket/commit/fb74f3de62b8525512929a91ea517bac12bd6076) - Surface associated branch/worktree on work items: sidebar cards show a branch glyph badge and the editor header gains a branch + worktree row with an "Open Worktree" quick action. Stale worktrees (folder no longer on disk) are visually distinguished. The Start Git Work extension exposes the association via a new public `registerGitWorkResolver` API so the core extension can render the badge without parsing the private `work-started` activity-log schema.

### Patch Changes

- [#724 Cap WorkGraph activity detail at 8 KiB and warn on truncation](https://github.com/devdocket/devdocket/pull/724) [`46c367b`](https://github.com/devdocket/devdocket/commit/46c367b96f09d2d407fa1ff1b202a3305378d358) - Cap activity log detail strings at 8 KiB, truncating oversized entries with a clear marker and logging a warning so extensions cannot bloat persisted work item storage.

## 0.3.0

### Minor Changes

- [#659 Make Start Git Work cancellation-aware](https://github.com/devdocket/devdocket/pull/659) [`f03b402`](https://github.com/devdocket/devdocket/commit/f03b40203818b95cc3a33379af328814ed04892c) - Add a shared `abortFromToken` helper and let Start Git Work flows be cancelled while surfacing cleanup guidance for partially created worktrees.

- [#660 Add GitHub SSO recovery prompts](https://github.com/devdocket/devdocket/pull/660) [`1ec2cab`](https://github.com/devdocket/devdocket/commit/1ec2caba27ca7bbfc31de5e4dbe23b8443762540) - Add a shared recoverable-error contract so providers can supply recovery actions without teaching the core extension about provider-specific failures, and use it for GitHub SSO authorization prompts and deduplicated background refresh notifications.

- [#653 Cancel abandoned auth retries before prompting users](https://github.com/devdocket/devdocket/pull/653) [`b7b0c5e`](https://github.com/devdocket/devdocket/commit/b7b0c5ec5e5c7e315d6bcc3796d18b6b43030831) - Prevent background and cancelled auth flows from reusing orphaned VS Code authentication sessions, and only prompt interactively after a silent session check for user-initiated refreshes and PR actions.

- [#671 Add rate-limit backoff for watches and refreshes](https://github.com/devdocket/devdocket/pull/671) [`7187dc7`](https://github.com/devdocket/devdocket/commit/7187dc7dede610ebc9bd4fae1ac95060550add47) - Add shared polling backoff support and teach DevDocket watches/providers to honor throttling signals like Retry-After, GitHub rate-limit resets, and temporary upstream outages before retrying.

- [#673 Surface Start Git Work earlier in the work item flow](https://github.com/devdocket/devdocket/pull/673) [`c52f74c`](https://github.com/devdocket/devdocket/commit/c52f74c02f096099f3e82ce651a5e72f45e11f50) - Show Start Git Work earlier in the DevDocket flow by surfacing it for Ready to Start items and directly in Incoming previews.

- [#661 Unify URL-resolve results with ProviderItem metadata](https://github.com/devdocket/devdocket/pull/661) [`22e4496`](https://github.com/devdocket/devdocket/commit/22e4496d38f1f027e71f1665a1995491c7ef2fd9) - Unify provider URL resolution with ProviderItem so imported items keep provider capabilities and metadata, enable Start Git Work for GitHub URL-imported issues and pull requests, and replace `ResolvedItem` / `ProviderResolvedItem` with `ResolvedUrlResult` for the registry-level pairing of `providerId` plus resolved item. Provider `resolveUrl` implementations now return `ProviderItem` directly, while `ProviderRegistry.resolveUrl` returns `ResolvedUrlResult`. Also fixes Azure DevOps pull requests imported by URL so Start Git Work can use provider-supplied git metadata across reloads, and accepts valid Azure DevOps HTTPS clone URLs during PR checkout.

Migration notes: remove `ResolvedItem` and `ProviderResolvedItem` imports, update provider `resolveUrl` implementations to return `Promise<ProviderItem | undefined>`, and if you consume registry-level URL resolution use the new exported `ResolvedUrlResult` shape: `{ providerId, item }`. Ensure your resolved `ProviderItem` still sets `url` so imported work items link back to the source. Notes seeding for URL-created work items now comes from `item.description` in the core URL-import flow instead of a dedicated type field, so providers can no longer return a distinct notes seed separate from `description`.

### Patch Changes

- [#674 Abort stale provider refreshes during reconfiguration](https://github.com/devdocket/devdocket/pull/674) [`614a27a`](https://github.com/devdocket/devdocket/commit/614a27a63cf4fd88a4dac2c7649e74a03cdbf28a) - Abort in-flight provider refreshes before rebuilding GitHub and Azure DevOps providers on configuration changes so disposed providers cannot emit stale results after replacement.

## 0.2.0

### Minor Changes

- [#627 Throttle provider refreshes in unfocused windows](https://github.com/devdocket/devdocket/pull/627) [`3789ea0`](https://github.com/devdocket/devdocket/commit/3789ea05145bb8b1e5c037cb73375fe716e75db0) - Throttle background provider refreshes when the VS Code window is unfocused so background windows still poll for new notifications while reducing redundant API calls across multiple windows.

## 0.1.0

### Minor Changes

- [#593](https://github.com/devdocket/devdocket/pull/593) [`a88c1ef`](https://github.com/devdocket/devdocket/commit/a88c1ef53be6958d4bb662a51b7694bc8918e0b2) Thanks [@mthalman](https://github.com/mthalman)! - Initial public release.

# Weekly Expert Codebase Review — 2026-04-27

This document records findings from the automated weekly codebase review.
Each finding below is a novel issue not already tracked in the issue list
(checked against all open and closed issues as of 2026-04-27).

---

## Finding 1: WatcherService polling interval ignores runtime configuration changes

**Pattern:** Configuration change not respected at runtime  
**Files:** `packages/core/src/services/watcherService.ts` (~lines 408–421)

### Problem

`WatcherService` reads the polling interval once when `ensurePollingActive()` is called
and creates a fixed-interval timer. If the user changes
`devDocket.watches.pollingIntervalSeconds` in settings after polling has started, the
change never takes effect — the old interval is locked in until all active watches
complete and polling naturally restarts.

```ts
private ensurePollingActive(): void {
  if (this.pollTimer) {
    return; // Already active — interval is never re-read
  }
  const intervalSeconds = this.getPollingInterval();
  this.pollTimer = setInterval(() => { ... }, intervalSeconds * 1000);
}
```

The early `return` when `this.pollTimer` is already set means a config change can never
restart the timer with the new value.

### Concrete downside

`devDocket.watches.pollingIntervalSeconds` is a documented, user-facing setting. Users
who change it expect the polling frequency to adjust immediately — standard VS Code
extension behavior. Instead, the change silently has no effect until the entire Watches
view goes idle (all runs complete / all PRs merge), which may never happen in a typical
session.

### Fix

Subscribe to `vscode.workspace.onDidChangeConfiguration` inside `WatcherService`. When
`devDocket.watches.pollingIntervalSeconds` changes: stop the current timer with
`stopPolling()` and call `ensurePollingActive()` to restart with the new interval if any
pollable watches exist. This is the same pattern used by `BaseProvider.startPeriodicRefresh()`.

---

## Finding 2: GitHubMentionsProvider reads undeclared config key, making per-repo mention scoping non-functional

**Pattern:** Dead code due to removed configuration schema entry  
**Files:** `packages/github/src/githubMentionsProvider.ts` (lines 123–126), `packages/github/package.json`

### Problem

`GitHubMentionsProvider.getConfiguredRepos()` reads `devDocketGithub.repos` as a
`string[]`, but `devDocketGithub.repos` is not declared in `packages/github/package.json`.
The package only declares `devDocketGithub.filteredRepos` (introduced in #374).
Because the config key is undeclared, `getConfiguredRepos()` always returns `[]`.

```ts
private getConfiguredRepos(): string[] {
  const config = vscode.workspace.getConfiguration('devDocketGithub');
  return config.get<string[]>('repos', []); // always returns [] — key not in schema
}
```

### Concrete downside

The early-return branch in `fetchMentionedItems()` (`if (repos.length > 0)`) is dead
code — it can never be reached. The provider always falls through to `fetchAllMentions()`,
which searches globally across all repos the user has access to. Users who want to
restrict mention searching to specific repos have no supported way to do so, even though
the code purports to support it.

### Fix

**Option A** — Restore and declare `devDocketGithub.repos` as a `string[]` in
`package.json`, keeping the existing per-repo fan-out logic.

**Option B** — Remove `getConfiguredRepos()` and apply `filteredRepos` patterns as
post-filtering (matching the approach used by all other GitHub providers via
`getConfiguredPatterns()`). Simpler and consistent with the current configuration model.

---

## Finding 3: DiscoveredStateStore grows unbounded — no pruning for stale state records

**Pattern:** Unbounded storage growth  
**Files:** `packages/core/src/storage/discoveredStateStore.ts`

### Problem

`DiscoveredStateStore` persists an `inboxState` record (`unseen | accepted | dismissed`)
for every item ever returned by any provider. When a provider removes an item — because
the underlying issue is closed, the PR is merged, or the item no longer matches the
query — its state record stays in `globalState` forever. There is no pruning mechanism.

### Contrast with ReadStateStore

`ReadStateStore` (which tracks which inbox items have been "read") *does* have a pruning
path: `InboxTreeProvider.pruneSeenItems()` removes keys for items no longer present in
any provider's active discovered-items list. `DiscoveredStateStore` has no equivalent.

### Concrete downside

For a user working with active repositories over months or years:
- GitHub issues are opened and closed continuously. Each newly discovered issue adds a
  record; closed issues disappear from the provider but their state records remain.
- In repositories with high issue churn, the store accumulates thousands of stale records.
- VS Code's `globalState` is backed by a SQLite database. The entire store is loaded into
  memory on `load()` at every activation. Unbounded growth degrades startup performance
  and wastes the limited per-extension storage budget.

### Fix

Add a post-refresh pruning pass (mirroring `pruneSeenItems()`) that removes state records
for items no longer present in any registered provider's discovered-items list, with a
grace period to avoid false pruning during transient API failures. Alternatively, add a
bounded TTL (e.g., records not updated in 90 days are pruned at activation).

---

## Finding 4: syncProviderTitles and syncProviderDescriptions scan all providers on every change instead of just the refreshed one

**Pattern:** Over-broad event subscription causing unnecessary O(n) scans  
**Files:** `packages/core/src/extension.ts` (wireEvents), `packages/core/src/services/titleSync.ts`, `packages/core/src/services/descriptionSync.ts`

### Problem

`syncProviderTitles()` and `syncProviderDescriptions()` are triggered by
`providerRegistry.onDidChangeDiscoveredItems`, which fires whenever *any* provider
updates. Both functions iterate *all* providers' discovered items regardless of which
provider triggered the event.

```ts
// wireEvents() in extension.ts
const discoveredSub = providerRegistry.onDidChangeDiscoveredItems(safeHandler('...', () => {
  void syncProviderTitles(providerRegistry, workGraph).catch(...)
  void syncProviderDescriptions(providerRegistry, workGraph).catch(...)
}));
```

Both `syncProviderTitles` and `syncProviderDescriptions` call
`providerRegistry.getAllDiscoveredItems()` and iterate all providers.

### Concrete downside

In a multi-provider setup (GitHub issues + PR reviews + My PRs + Mentions + ADO), a
single provider refresh triggers two full scans of every discovered item across all
registered providers. With 4 providers × 500 items each = 2,000 `findItemByProvenance()`
lookups × 2 functions = 4,000 provenanceIndex lookups per refresh tick.

Additionally, `onDidChangeDiscoveredItems` fires more frequently than
`onDidRefreshProvider` — it fires during provider registration and on intermediate state
updates — causing unnecessary scans before items are even available.

### Fix

Scope title and description sync to the specific provider that refreshed, using
`onDidRefreshProvider` (which already carries `providerId`) instead of
`onDidChangeDiscoveredItems`. This is the same scoped-per-provider pattern used by
`checkAutoComplete()`. Update both sync functions to accept an optional `providerId`
argument and iterate only that provider's items when provided. This reduces the scan from
O(all_providers × all_items) to O(one_provider_items) per refresh.

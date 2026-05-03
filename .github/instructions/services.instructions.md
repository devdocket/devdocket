---
applyTo: "**/services/**"
---

# Service Conventions

## Event-Driven Update Cycle

State changes follow a **mutate → save → fire → refresh** cycle:
1. Mutate the in-memory object
2. Persist to disk via the store
3. Fire an `onDidChange` event
4. UI tree data providers refresh in response

Provider refreshes are separate — they happen on a periodic schedule or via explicit user-triggered refresh commands.

## Provider Health Tracking

`ProviderRegistry` tracks health via `ProviderHealthStatus` with status (`'healthy' | 'unhealthy' | 'unknown'`), `lastRefreshTime`, and `lastError`. Health updates happen in two places:

- **`refreshWithTimeout()`** — invoked at provider registration and from `refreshAll()`. Successful refresh → `'healthy'`; error → `'unhealthy'` with message; timeout → `'unhealthy'` with `'Refresh timed out'`.
- **`handleDiscoveredItems()`** — invoked whenever a provider emits items via `onDidDiscoverItems`. Marks the provider `'healthy'` regardless of how the emission was triggered. This is the only health signal for providers extending `BaseProvider`, because `BaseProvider`'s internal `setInterval` calls `doBackgroundRefresh()` directly and bypasses `refreshWithTimeout()`. Without this path a provider that went unhealthy on its initial refresh would stay unhealthy even though every subsequent background refresh was succeeding.

`updateHealth()` is a no-op when status is unchanged, so calling it on every emission is cheap. The `onDidChangeProviderHealth` event drives UI reactivity. Health tracking only works if providers let refresh failures reject — see `providers.instructions.md` for provider-side guidance.

## Idempotent Watcher Start

`WatcherService.startWatch(identifier)` and `WatcherService.startPRWatch(identifier, options?)` are **idempotent**: re-invoking them for an already-active watch returns the existing watch unchanged rather than throwing. Callers that need to distinguish "already active" from "newly created" can check `isRunActive(id)` / `isPRActive(id)` before calling.

`startPRWatch` additionally accepts `{ forceRecreate: true }`. The manual "Watch URL" command passes this so it can recover invisible PRs (PRs whose child runs were all dismissed, leaving the panel filter to hide the parent). With `forceRecreate`, the existing PR watch and its owned child runs are wiped before fetching a fresh snapshot. The auto-watch path (`autoWatchAuthoredPRs` in `extension.ts`) does **not** pass `forceRecreate` because it gates on `isPRWatched()` first.

## Concurrency Guard

`WatcherService.pollAllWatches()` uses an `isPollInFlight` flag to skip ticks if a previous poll is still running. This follows the `BaseProvider` pattern and prevents overlapping polls from queuing up.

## Version-Based Resurfacing

`DiscoveredItem.version` enables **soft resurfacing**: when an `accepted` item's stored version differs from the incoming version, state resets to `unseen`. Suppressed for items in `New`/`InProgress`/`Paused` states.

`DiscoveredItem.resurfaceVersion` enables **hard resurfacing**: always resurfaces regardless of WorkItem state.

Dismissed items are never resurfaced by either mechanism.

## 3-Strike Failure Handling

After 3 consecutive poll failures on a watched run, set `hasWarning: true` and skip that run in subsequent polls. The run stays visible with a warning icon.

`hasWarning` is a watcher-health concern, **not** a "CI failed" signal. Don't conflate the two when rendering CI badges. `MainViewProvider.getRunCIBadge` / `getPRCIBadge` only show "CI failed" via `isFailedRun()` — which itself excludes `cancelled` / `skipped` / `neutral` conclusions, since those are explicit non-results rather than failures.

## Watch Panel PR Filter

`WatchPanelProvider.refresh()` filters PR watches with `runs.length === 0` so PRs without detected CI runs don't clutter the panel. This means a PR can be actively watched (and visible to the auto-watcher) without appearing in the panel. The "Watch URL" idempotent + `forceRecreate` path is the user-recoverable escape hatch when a PR ends up invisible after all its children were dismissed.

## Canonical ID Deduplication

`buildCanonicalHiddenSet()` in `canonicalDedup.ts` handles inbox dedup: for unseen items sharing a `canonicalId`, keep the alphabetically-first `providerId::externalId` and hide the rest. Used by `MainViewProvider` (Incoming tier rendering), `inboxBadge` (activity-bar unread count), and `inboxCommands` (Accept All).

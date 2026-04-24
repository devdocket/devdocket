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

`ProviderRegistry` tracks health via `ProviderHealthStatus` with status (`'healthy' | 'unhealthy' | 'unknown'`), `lastRefreshTime`, and `lastError`. Health updates inside `refreshWithTimeout()`:
- Successful refresh → `'healthy'`
- Error → `'unhealthy'` with message
- Timeout → `'unhealthy'` with "Refresh timed out"

The `onDidChangeProviderHealth` event drives UI reactivity. Health tracking only works if providers let refresh failures reject — see `providers.instructions.md` for provider-side guidance.

## Concurrency Guard

`WatcherService.pollAllWatches()` uses an `isPollInFlight` flag to skip ticks if a previous poll is still running. This follows the `BaseProvider` pattern and prevents overlapping polls from queuing up.

## Version-Based Resurfacing

`DiscoveredItem.version` enables **soft resurfacing**: when an `accepted` item's stored version differs from the incoming version, state resets to `unseen`. Suppressed for items in `New`/`InProgress`/`Paused` states.

`DiscoveredItem.resurfaceVersion` enables **hard resurfacing**: always resurfaces regardless of WorkItem state.

Dismissed items are never resurfaced by either mechanism.

## 3-Strike Failure Handling

After 3 consecutive poll failures on a watched run, set `hasWarning: true` and skip that run in subsequent polls. The run stays visible with a warning icon.

## Canonical ID Deduplication

`buildCanonicalHiddenSet()` in `canonicalDedup.ts` handles inbox dedup: for unseen items sharing a `canonicalId`, keep the alphabetically-first `providerId::externalId` and hide the rest. Used by `InboxTreeProvider` and inbox badge.

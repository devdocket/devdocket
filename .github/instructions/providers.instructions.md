---
applyTo: "packages/github/**,packages/ado/**"
---

# Provider Conventions

## Base Class Selection

- **ADO providers** extend `BaseProvider` from `@devdocket/shared` (`packages/shared/src/baseProvider.ts`). Override `doBackgroundRefresh()` for non-interactive periodic refresh and `refresh()` for user-triggered refresh that may prompt for auth.
- **GitHub providers** extend `BaseGitHubProvider` from `packages/github/src/baseGithubProvider.ts`, which implements `DevDocketProvider` directly. Override `fetchAndPublish(accessToken, isUserTriggered)`.

These are different base classes — do not mix them.

## Stable External IDs

Use `owner/repo#number` format for external IDs, not `html_url`. URLs are mutable (issues can transfer between repos); the parsed format is stable and provides reliable long-term identity.

URL-imported items use `providerId: 'url-import'` and `externalId: <canonical URL>` to avoid coupling core to provider-specific ID formats.

## Health Reporting

Let refresh failures reject (or rethrow after logging) so `ProviderRegistry.refreshWithTimeout()` can track health correctly. If a provider catches errors internally and resolves `refresh()` successfully, the registry will treat it as healthy even when it's not.

## CancellationToken → AbortSignal Wiring

Create `AbortController` at the refresh entry point and wire `token?.onCancellationRequested?.(() => abortController.abort())` with **double optional chaining** (test mocks may lack the event method). Pass `abortController.signal` to all `fetch()` calls.

Use `combineSignals(signal, timeoutMs)` from `@devdocket/shared` to merge cancellation + per-request timeout into one signal (Node 18 compatible — `AbortSignal.any()` requires Node 20.3+).

Catch `AbortError` at the top level and log at debug level (not error). Guard rethrows with `&& signal?.aborted` to distinguish cancellation from timeouts. Throw `AbortError` (not break) in worker loops when `signal?.aborted` to propagate through `Promise.all`.

## ADO State-Category Filtering

Two-layer filtering for work items:
1. **WIQL layer:** Exclude common terminal states (`Closed`, `Removed`) for performance
2. **States API layer:** Call the Work Item Type States API per `(project, workItemType)` pair, filter by terminal categories (`Completed`, `Removed`, `Resolved`)

Cache key: `{project}/{workItemType}`. Fail-open: if states API fails, return empty set (no filtering for that type).

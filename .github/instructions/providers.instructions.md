---
applyTo: "packages/github/**,packages/ado/**"
---

# Provider Conventions

## Base Class Selection

- **ADO providers** extend `BaseProvider` from `@devdocket/shared` (`packages/shared/src/baseProvider.ts`). Override `doBackgroundRefresh()` for non-interactive periodic refresh and `refresh()` for user-triggered refresh that may prompt for auth.
- **GitHub providers** extend `BaseGitHubProvider` from `packages/github/src/baseGithubProvider.ts`, which implements `DevDocketProvider` directly. Override `fetchAndPublish(accessToken, isUserTriggered)`.

These are different base classes — do not mix them.

## Item Type Classification

Set `DiscoveredItem.itemType` to `'issue'` or `'pr'` when the provider knows
the kind of item it's surfacing. The core extension renders this as a distinct
type pill (alongside the Provider, State, and CI badges) in both the sidebar
and editor. The field is purely advisory — leaving it `undefined` simply
suppresses the type pill, so manual / generic items don't get a misleading
label.

**Conventions:**

- **GitHub Issues provider** (`githubProvider.ts`): always `'issue'`.
- **GitHub PR providers** (`githubMyPrsProvider.ts`, `githubPrReviewProvider.ts`):
  always `'pr'`.
- **GitHub Mentions provider** (`githubMentionsProvider.ts`): inspect the
  GitHub API response's `pull_request` field — `pr` if set, `issue` otherwise.
- **ADO Work Items provider** (`adoWorkItemProvider.ts`): always `'issue'`
  (work items are issue-shaped, even when their `System.WorkItemType` says
  `Bug`/`Task`/`User Story`).
- **ADO PR providers** (`baseAdoPrProvider.ts` and subclasses): always `'pr'`.

**Do not infer** itemType from URL patterns or state strings in the core
extension — it's the provider's job to classify, since only the provider has
authoritative knowledge of what it fetched.

## Pill Conventions (`DiscoveredItem.badges`)

The core extension owns three badge categories: **Provider** (GitHub/ADO/Manual),
**Type** (Issue/PR via `itemType`), and **CI** (from the watcher service). For
*everything else* — state, review status, the reason an item showed up in the
inbox — the provider is responsible for declaring badges via the
`DiscoveredItem.badges` field. The core never infers pills from the
`state` or `reason` strings.

### Variant → color mapping

Pick the severity that matches the meaning. Core maps each variant to a
theme-aware palette so providers don't pick raw colors.

| Variant     | Color   | Use for                                        |
|-------------|---------|------------------------------------------------|
| `neutral`   | outline | Category labels (e.g. `Draft`)                 |
| `info`      | blue    | Informational state (e.g. `Open`, `Review received`) |
| `success`   | green   | Positive state (e.g. `Approved`, `Ready to merge`) |
| `warning`   | amber   | Pending action (e.g. `Mentioned`, `Review requested`) |
| `danger`    | red     | Action needed (e.g. `Changes requested`)       |

### `show` filter

By default a badge renders in both the sidebar and the editor. Set
`show: 'editor'` for verbose labels that would clutter the sidebar (e.g. an
ADO custom workflow state); set `show: 'sidebar'` for badges only useful
during inbox triage.

### Per-provider conventions

| Provider | Badges emitted |
|---|---|
| `githubProvider` (Issues) | `Assigned` (warning) + `Open`/`Closed` state badge (`show: 'editor'`) |
| `githubMentionsProvider` | `Mentioned` (warning) + `Open`/`Closed` state badge (`show: 'editor'`) |
| `githubPrReviewProvider` | `Review requested` (warning) + `Open`/`Closed` state badge (`show: 'editor'`) |
| `githubMyPrsProvider` | One badge mapped from the computed PR status (`Draft` → neutral, `Changes requested` → danger, `Approved`/`Ready to merge` → success, `Review received`/`Waiting on reviews` → info), shown in both views since the status is also the state. See the `statusToBadge` helper. |
| `adoWorkItemProvider` | State badge from `System.State` (`show: 'editor'`, `info` variant). |
| `adoPrReviewProvider` (and other non-MyPrs subclasses of `BaseAdoPrProvider`) | State badge from `pr.status` via `buildAdoPrStateBadge` (`show: 'editor'`; `active` → info, others → neutral). |
| `adoMyPrsProvider` | State badge from the computed vote status via `buildAdoMyPrsStateBadge` (`show: 'editor'`; `Draft` → neutral, `Approved` → success, `Rejected` → danger, `Waiting for author` → warning, others → info). |

When adding a new provider, default to declaring **at least** a reason badge
(e.g. `'Mentioned'`, `'Review requested'`) plus a state badge with
`show: 'editor'` so users can see the upstream state in the editor without
cluttering the sidebar.

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

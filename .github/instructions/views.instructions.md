---
applyTo: "**/views/**"
---

# View Conventions

## Architecture

The DevDocket UI is a **single Preact-based webview view** (`devdocket.main`, registered in `packages/core/src/views/mainViewProvider.ts`) plus a separate floating webview panel for CI Watches (`devdocket.watchPanel`). There are **no** VS Code TreeView providers in the core extension — the legacy multi-tree-view layout (Inbox / Queue / Focus / History / Sources) was replaced by a unified tier-based webview as part of #454.

When adding a new piece of UI:

- Prefer extending the existing tiers / tabs in `mainViewProvider.ts` rather than introducing a new top-level view.
- The webview entry points are bundled by esbuild from `src/webview/sidebar/`, `src/webview/editor/`, and `src/webview/watchPanel/` into `webview-dist/*.js`.

## Tier Names (User-Facing)

The My Work tab renders five tiers in this order. Use these exact names in any user-facing text (status bar, notifications, walkthroughs, docs):

1. **Incoming** (icon `↓`) — provider items with `inboxState === 'unseen'`.
2. **In Progress** (icon `▶`) — `WorkItemState.InProgress`.
3. **Ready to Start** (icon `○`) — `WorkItemState.New` (the "queue" concept).
4. **Paused** (icon `⏸`) — `WorkItemState.Paused`.
5. **Done** (icon `✓`) — `WorkItemState.Done` and `Archived`.

Do **not** use the legacy view names ("Inbox view", "Queue view", "Focus view", "History view") in user-facing text. Internal docs/code may still reference "inbox state" / "queue" as concepts where it's clearer.

## Provider Health Indicators

In the Sources tab, providers that have failed to refresh display:
- A warning indicator (`⚠`) next to the provider name.
- A `health-warning` CSS class on the section so theming can color it.

The status-bar item also reflects unhealthy providers; see `services/providerHealthStatusBar.ts`.

## Badges (`packages/core/src/views/badges.ts`)

Badges shown next to item titles fall into four categories:

1. **Provider** (GitHub / ADO / Manual) — derived from `providerId`.
2. **Type** (Issue / PR) — derived from `ProviderItem.itemType`.
3. **CI** (passed / failed / running / etc.) — derived from the watcher service.
4. **Provider-supplied** — declared by providers via `ProviderItem.badges` and rendered through `buildProviderBadges(item, view)`.

Core never infers state badges from `ProviderItem.state` or `reason` strings — providers must declare them explicitly. See `.github/instructions/providers.instructions.md` for the badge conventions.

## Panel Lifecycle

`WorkItemEditorPanel` receives a `PanelManager` plus its action/state/watch dependencies through its `open(...)` factory. `IncomingPreviewPanel` receives an `IncomingPreviewPanelManager` through its `open(...)` factory. Instantiate both managers during `activate()` and dispose them with the extension context so panel caches are scoped to one activation; do not add mutable static dependency singletons to view modules.

## Webview Security

- CSP: `default-src 'none'` — whitelist only what's needed (`style-src 'nonce-…'`, `script-src 'nonce-…'`). All three webviews (`mainViewProvider.ts`, `watchPanelProvider.ts`, `editorPanelHtml.ts`) gate inline `<style>` and `<script>` tags through a per-mount CSPRNG nonce; do **not** introduce `'unsafe-inline'` for either.
- Use `escapeHtml()` for text content, `escapeAttr()` for attribute values (different escape sets).
- External links via `postMessage` + `isSafeUrl()` — never call `window.open`/anchor `href` directly from webview JS.
- Use `appendText()` for user-controlled strings in `MarkdownString`, not `appendMarkdown()` — prevents markdown injection.

## Theming

Tier colors are defined in `packages/core/src/webview/shared/colors.ts` with both dark and light variants. Use `buildTierColorCss(theme)` to inject the `--tier-*` CSS custom properties at the top of any new webview that wants to use them. The CI Watches panel does this so its tier-colored cards match the sidebar.

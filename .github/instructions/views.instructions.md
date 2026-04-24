---
applyTo: "**/views/**"
---

# View Conventions

## Tree Item Descriptions

Use `buildDescription()` from `viewUtils.ts` to construct tree item descriptions. It filters undefined values gracefully. Layout-aware patterns per view:

- **Inbox**: `group` in tree mode; `group · provider` in flat mode
- **Queue**: `group` in tree mode; `group · provider` in flat mode
- **Focus**: `group · state` in tree mode; `group · provider · state` in flat mode
- **History**: `group · state` in tree mode; `group · provider · state` in flat mode

## Shared View Utilities (`viewUtils.ts`)

- **`buildWorkItemTooltip(item, title, options?)`** — Unified tooltip builder with configurable `showState`, `timestamp` field, `timestampLabel`, and `notesStyle`. Use instead of per-view private `buildTooltip` methods.
- **`getWorkItemIcon(state)`** — Single icon-resolution function for all `WorkItemState` values. Use instead of per-view `getIcon` methods.

When extracting shared view utilities, use options objects (not method overloading) to handle per-view differences.

## Layout Toggle

Each view supports flat/tree layout modes:

- Two command IDs per toggle, each with its own icon
- Context keys set on activation + config change listener
- Use `LayoutState` class from `viewLayout.ts` for layout management

## Tree Node Counts

Parent nodes show `(N)` child count in their description. Unhealthy providers show "refresh failed" instead of a count.

## Provider Health Indicators

- Warning icon (`problemsWarningIcon.foreground`) when provider is unhealthy
- Description shows "refresh failed" text
- Tooltip always shows provider name, last refresh time (relative), and error details when unhealthy
- Unhealthy providers with 0 items still appear in Sources tree so the warning is visible

## Context Value Suffixes

Tree items append contextValue suffixes for conditional menu items:
- `.hasPrUrl` — when item has both `url` and `isPullRequest: true`, enabling "Watch CI" menus

## PanelManager Lifecycle

`WorkItemEditorPanel` uses a `PanelManager` class instantiated during `activate()` and disposed with the extension context. The static `setPanelManager()` pattern preserves the static API facade while scoping panel cache ownership to the extension lifecycle.

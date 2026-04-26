---
applyTo: "**/commands/**"
---

# Command Conventions

## All Commands Belong in Core

All VS Code commands live in `packages/core/src/commands/`. Providers register via `api.registerProvider()` and actions via `api.registerAction()` — neither registers commands directly.

## Domain Module Pattern

Commands are split into domain-specific modules, each exporting a single `register*Commands()` function:

| Module | Scope |
|--------|-------|
| `inboxCommands.ts` | Inbox accept/dismiss operations |
| `queueCommands.ts` | Queue reorder/transition operations |
| `focusCommands.ts` | Focus pause/resume/complete operations |
| `historyCommands.ts` | History cleanup operations |
| `layoutCommands.ts` | Per-view layout toggles |
| `generalCommands.ts` | Item creation, general operations |
| `sourcesCommands.ts` | Sources view operations |
| `watchCommands.ts` | CI watch management |

The orchestrator `commands.ts` calls each domain registrar, passing only the dependencies that module needs.

## Shared Utilities (`commandUtils.ts`)

- `wrapCommand` — Error-handling wrapper for command handlers
- `handleCommandError` — Standardized error display
- `resolveItemIds` — Extract item IDs from command arguments
- `formatItemTitle` — Format discovered item titles for display
- `batchTransition` — Batch state transitions with error accumulation
- `batchAcceptItems` — Batch inbox accept operations

Domain-specific type guards (e.g., `isInboxItem`, `isSourceItem`) stay in their domain modules.

## Menu Placement

Use group sort order to control context menu item ordering: `3_reorder@0` (first), `@1` (second), `@2` (third), `@3` (fourth). This determines the visual order within a menu group.

## Command Naming

All commands use the `devdocket.` prefix. Queue and Focus have separate command IDs for the same logical operation (e.g., `devdocket.moveToTop` vs `devdocket.focusMoveToTop`).

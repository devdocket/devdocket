---
applyTo: "**/commands/**"
---

# Command Conventions

## All Commands Belong in Core

All VS Code commands live in `packages/core/src/commands/`. Providers register via `api.registerProvider()` and actions via `api.registerAction()` — neither registers commands directly.

## Command Registration Pattern

`commands.ts` is the source of truth for active VS Code command registration. A command is active only when it is registered directly in `commands.ts` or through a registrar that `commands.ts` imports and calls.

Currently wired extracted modules:

| Module | Scope |
|--------|-------|
| `inboxCommands.ts` | Incoming-tier accept/dismiss operations (provider items in `inboxState === 'unseen'`) |
| `watchCommands.ts` | CI watch management |

Other files under `commands/` may contain shared types, utilities, or not-yet-wired extraction work. Do not add duplicate command registrars unless `commands.ts` is updated to call them, and remove registrars that are no longer wired.

> Some module names use legacy concept names (such as Inbox) because those still describe the underlying state-machine stages. The user-facing tier names are different — see `.github/instructions/views.instructions.md`.

## Shared Utilities (`commandUtils.ts`)

- `wrapCommand` — Error-handling wrapper for command handlers
- `handleCommandError` — Standardized error display
- `resolveItemIds` — Extract item IDs from command arguments
- `formatItemTitle` — Format discovered item titles for display
- `batchTransition` — Batch state transitions with error accumulation
- `batchAcceptItems` — Batch inbox-accept operations

Domain-specific type guards (e.g., `isInboxItem`, `isSourceItem`) stay in their domain modules.

## Menu Placement

The new sidebar is a webview, so the legacy `view/item/context` menu definitions for the per-tier `Inbox` / `Queue` / `Focus` / `History` tree views no longer drive any UI surface. Hover actions on cards inside the sidebar are wired up directly in the Preact component tree (`src/webview/sidebar/components/ItemCard.tsx`).

`package.json` `contributes.menus` entries are still in active use for:

- **`view/title`** — the create / refresh buttons that appear in the DevDocket sidebar header (`when: view == devdocket.main`). These are real UI affordances; do not remove them.
- **`commandPalette`** — palette visibility for everything `devdocket.*`, including the `when: false` entries that hide internal commands (`devdocket.addActivity`, `devdocket.watchPRFromItem`, `devdocket.copyUrl`) from the palette.

Only the per-item context-menu entries (`view/item/context` group) are dead now that the legacy tree views are gone.

## Command Naming

All commands use the `devdocket.` prefix. Ready-to-Start and Focus commands may have separate command IDs for the same logical operation (e.g., `devdocket.moveToTop` vs `devdocket.focusMoveToTop`) because they target items in different state-machine stages.

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
| `inboxCommands.ts` | Incoming-tier accept/dismiss operations (provider items in `inboxState === 'unseen'`) |
| `queueCommands.ts` | Ready-to-Start tier reorder/transition operations |
| `focusCommands.ts` | In Progress / Paused tier pause/resume/complete operations |
| `historyCommands.ts` | Done tier cleanup operations |
| `generalCommands.ts` | Item creation, general operations |
| `sourcesCommands.ts` | Sources tab operations |
| `watchCommands.ts` | CI watch management |

The orchestrator `commands.ts` calls each domain registrar, passing only the dependencies that module needs.

> The module names use the legacy concept names (Inbox / Queue / Focus / History) because those still describe the underlying state-machine stages. The user-facing tier names are different — see `.github/instructions/views.instructions.md`.

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

All commands use the `devdocket.` prefix. Queue and Focus have separate command IDs for the same logical operation (e.g., `devdocket.moveToTop` vs `devdocket.focusMoveToTop`) because they target items in different state-machine stages.

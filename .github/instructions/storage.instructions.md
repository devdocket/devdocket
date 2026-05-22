---
applyTo: "**/storage/**"
---

# Storage Conventions

## File-backed Stores

User-intent stores persist to JSON files under `globalStorageUri` via `vscode.workspace.fs`, not `globalState`. Each file-backed store receives a `JsonFileStore` (or compatible `FileStore`) and re-reads from disk on load so cross-window invalidation can observe fresh data.

`JsonTaskStore`, `InboxStateStore`, and `ReadStateStore` keep in-memory caches plus merge-on-write logic: they re-read the backing file before each persist, merge remote changes with local edits, and then write the merged result back. `WatchStore` is also file-backed and merges against the latest on-disk snapshot while preserving remote-only entries the current window has not loaded.

Because there is no cross-process file-locking or write queue, merge-on-write is still best-effort conflict reduction even though `JsonFileStore` uses a temp-file plus rename pattern for atomic replacement of the final file. Callers should still keep writes scoped to user-intent mutations.

## One-time Migrations

`migrateToGlobalState()` in `migration.ts` handles the older one-off migration from legacy JSON files (in `globalStorageUri`) to `globalState`. It is idempotent — guarded by the `devdocket.migrated` flag — and only marks migration complete when every file either migrated successfully or was confirmed absent.

`migrateGlobalStateToFiles()` handles the follow-up migration from `globalState` into the new file-backed stores. It is guarded by `devdocket.migrated-to-files`, skips files that already exist so retries do not clobber newer file-backed data, and deliberately leaves the old `globalState` keys in place as rollback fallback.

### Field Validators

Composable validators in `validation.ts` replace hand-rolled `typeof` checks:

- `validateObject(value, context)` — Ensures value is a non-null object.
- `requiredString(obj, field, context)` — Required non-empty string.
- `optionalString(obj, field, context)` — Optional string.
- `requiredEnum(obj, field, validValues, context)` — Required enum member.
- `requiredFiniteNumber(obj, field, context)` — Required finite number.
- `optionalFiniteNumber(obj, field, context)` — Optional finite number.

Compose with nullish coalescing for short-circuit validation:

```ts
return requiredString(obj, 'id', ctx)
  ?? requiredEnum(obj, 'state', validStates, ctx)
  ?? optionalString(obj, 'url', ctx);
```

## Data Stores

Four user-intent files and one `globalState` cache hold persisted data:

- **`globalStorageUri\workitems.json`** — Persisted WorkItems with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`globalStorageUri\inbox-state.json`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.
- **`globalStorageUri\read-state.json`** — Set of inbox item IDs the user has viewed.
- **`globalStorageUri\watches.json`** — User-configured watch entries. The store is file-backed, but live cross-window invalidation is currently only wired for work items, inbox state, and read state; watch changes are picked up on reload.
- **`globalState['devdocket.provider-labels']`** — Cached mapping of `providerId` → display label (for example, `"github"` → `"GitHub Issues"`). Provider labels are not part of cross-window propagation; startup staleness is acceptable.

## Provider Items Are References, Not Copies

Items in the Incoming tier and the Sources tab are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies. Never cache or persist provider item data beyond the thin `inbox-state.json` file-backed record.

---
applyTo: "**/storage/**"
---

# Storage Conventions

## Memento-backed Stores

All stores persist data via VS Code's `Memento` (`globalState`) API. Each store takes a `Memento` in its constructor and writes via `this.globalState.update(key, data)`.

Most stores (e.g., `JsonTaskStore`, `InboxStateStore`, `ReadStateStore`) maintain an in-memory cache populated on first load and expose a private `persist()` method. Simpler stores (e.g., `WatchStore`) read/write directly without a cache. Loading methods vary by store (`loadAll()`, `load()`).

Because `globalState.update()` is atomic from the extension's perspective, there is no write-queue or file-level locking. Stores no longer extend a base class.

## One-time Migration

`migrateToGlobalState()` in `migration.ts` handles the one-off migration from legacy JSON files (in `globalStorageUri`) to globalState. It is idempotent — guarded by the `devdocket.migrated` flag — and only marks migration complete when every file either migrated successfully or was confirmed absent.

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

Five globalState keys hold persisted data:

- **`devdocket.workitems`** — Persisted WorkItems with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`devdocket.inbox-state`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.
- **`devdocket.read-state`** — Set of inbox item IDs the user has viewed.
- **`devdocket.provider-labels`** — Cached mapping of `providerId` → display label (for example, `"github"` → `"GitHub Issues"`).
- **`devdocket.watches`** — User-configured watch entries.

## Provider Items Are References, Not Copies

Items in the Incoming tier and the Sources tab are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies. Never cache or persist provider item data beyond the thin `devdocket.inbox-state` globalState entry.

---
applyTo: "**/storage/**"
---

# Storage Conventions

## Write Queue Serialization

All JSON-backed stores extend `SerializedJsonStore` (in `serializedJsonStore.ts`), which provides a **writeQueue** (promise chain) via `enqueue()` to prevent concurrent writes from corrupting JSON files. New stores should extend this base class rather than implementing their own queue.

### Base Class Helpers

- `enqueue(op)` — Serializes write operations through a promise chain.
- `readJson(filePath, maxSize?)` — Reads, stat-checks, and parses a JSON file with corruption guards and backup.
- `writeJson(filePath, data)` — Writes pretty-printed JSON, creating the directory if needed.
- `backupFile(filePath)` — Renames corrupt files with a `.corrupt.<timestamp>` suffix.
- `flush()` — Returns a promise that resolves when all queued writes complete.

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

Two JSON files live in `globalStorageUri`:

- **`workitems.json`** — Persisted WorkItems with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`discovered-state.json`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.

## Provider Items Are References, Not Copies

Items in Inbox and Sources are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies. Never cache or persist provider item data beyond the thin `discovered-state.json` index.

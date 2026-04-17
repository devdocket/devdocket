---
applyTo: "**/storage/**"
---

# Storage Conventions

## Write Queue Serialization

Both `JsonTaskStore` and `DiscoveredStateStore` use a **writeQueue** (promise chain) to prevent concurrent writes from corrupting JSON files. Always follow this pattern for any new store.

### Pattern

```ts
private writeQueue: Promise<void> = Promise.resolve();

private enqueueWrite(fn: () => Promise<void>): Promise<void> {
  this.writeQueue = this.writeQueue.then(fn, fn);
  return this.writeQueue;
}
```

All write operations must go through `enqueueWrite()` so they execute sequentially, even when called concurrently from multiple async paths.

## Data Stores

Two JSON files live in `globalStorageUri`:

- **`workitems.json`** — Persisted WorkItems with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`discovered-state.json`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.

## Provider Items Are References, Not Copies

Items in Inbox and Sources are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies. Never cache or persist provider item data beyond the thin `discovered-state.json` index.

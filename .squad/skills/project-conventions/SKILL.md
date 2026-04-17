---
name: "project-conventions"
description: "Core conventions and patterns for the DevDocket codebase"
domain: "project-conventions"
confidence: "high"
source: "codebase"
---

## Context

DevDocket is a **TypeScript monorepo** for a VS Code extension that manages work items from multiple sources. The codebase emphasizes **type safety, event-driven architecture, and serialized state management**. These documented patterns are extracted directly from the working codebase.

## Patterns

### Storage & Serialization: WriteQueue Pattern

All persistent stores (`JsonTaskStore`, `DiscoveredStateStore`) use an internal **promise chain** to serialize writes and prevent concurrent file corruption.

**Why:** VS Code extensions run in a single-threaded Node.js environment, but async operations can interleave. A writeQueue ensures all disk writes happen sequentially.

**Pattern:**
```typescript
// Both stores use an enqueue() helper that chains onto writeQueue:
private writeQueue: Promise<void> = Promise.resolve();

private enqueue(op: () => Promise<void>): Promise<void> {
  this.writeQueue = this.writeQueue.then(op, (err: unknown) => {
    logger.warn('Previous write operation failed, continuing queue', err);
    return op();
  });
  return this.writeQueue;
}
```

> **Note:** Both stores serialize writes via `enqueue()` and use rollback on write failure, but their update ordering differs. `DiscoveredStateStore` is consistently **cache-first** (updates the cache, then writes to disk; rolls back the cache on write failure). `JsonTaskStore` uses **operation-specific ordering**: `save`/`saveAll` are **disk-first** (write to disk, then update the cache), while `delete()` is **cache-first** (updates the cache, then persists, with rollback on failure). Refer to the real stores for full error handling.

**When creating a new store:** Always include `private writeQueue: Promise<void> = Promise.resolve()` and chain all writes through it.

### Event-Driven Architecture

State changes follow a **mutate → save → fire → refresh** cycle. When a WorkItem or inbox state changes:
1. Mutate the in-memory object
2. Persist to disk via the store
3. Fire an `onDidChange` event
4. UI tree data providers refresh in response to the event

> **Note:** Provider refreshes are separate — they happen on a periodic schedule or via explicit user-triggered refresh commands. State-store events (e.g., accepting/dismissing inbox items) drive UI view refreshes but do not trigger provider refreshes.

**Example:** Accepting an inbox item (from `commands.ts`):
```typescript
// In acceptSingleInboxItem() — called by the accept command handler
const createdItem = await workGraph.createItem(
  { title: formatItemTitle(item) },
  { providerId: item.providerId, externalId: item.externalId, url: item.url },
);
await stateStore.setState(item.providerId, item.externalId, 'accepted');
// stateStore fires onDidChange → UI refreshes
```

### Provider Items: References, Not Copies

Items in the Inbox and Sources views are **live references** to the provider's in-memory data. Only the **inbox state enum** (`unseen | accepted | dismissed`) is persisted in `discovered-state.json`.

**Why:** Keeps persisted state minimal and avoids storing duplicated item data. If a GitHub issue title changes, the UI reflects the latest title after the next provider refresh (periodic or user-triggered), without requiring any persisted-state update or migration.

**Pattern:**
```typescript
export interface DiscoveredStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;
  /** Version identifier used to detect when a previously accepted item needs re-attention. */
  version?: string;
  /** Secondary version identifier tracked independently from `version`. */
  resurfaceVersion?: string;
  // Only inboxState, version, and resurfaceVersion are persisted — not item data
}

// Item data (title, description, url) is always read live from provider:
export interface DiscoveredItem {
  externalId: string;
  title: string;  // Not persisted — always fresh from provider
  description?: string;
  url?: string;
  group?: string;
  reason?: string;
  /** Optional version that triggers resurfacing when it changes for an accepted item. */
  version?: string;
  /** Optional secondary version for independent resurfacing (e.g. re-requested reviews). */
  resurfaceVersion?: string;
}
```

### Monorepo Structure

```
packages/
  core/               — Main DevDocket extension (UI, work lifecycle, plugin API)
    src/
      services/      — ProviderRegistry, ActionRegistry, WorkGraph, logger
      commands/      — VS Code command handlers (accept, dismiss, focus, etc.)
      storage/       — JsonTaskStore, DiscoveredStateStore, stores with writeQueue
      models/        — WorkItem state machine
      views/         — Tree data providers (Inbox, Queue, Focus, History, Sources)
      api/           — Public API types (DevDocketApi, DevDocketProvider)
      utils/         — Shared utility functions
      test/
        __mocks__/   — Mocked vscode module (via vitest.config.ts alias)
        *.test.ts    — Unit/integration tests
    vitest.config.ts — Aliased vscode to __mocks__/vscode.ts
  shared/            — Reusable types and utilities
    src/
      baseProvider.ts    — Base class for periodic-refresh providers
      index.ts           — Barrel export (public API surface)
  github/            — GitHub provider extension
  ado/               — Azure DevOps provider extension
  ai-reviewer/       — AI review plugin extension
  start-git-work/    — Action extension for git branch/worktree creation
```

### Testing with Vitest

- **Framework:** [Vitest](https://vitest.dev/)
- **Test location:** `packages/*/src/test/**/*.test.ts`
- **Run commands:**
  - `npm run test` — All packages
  - `npm run test -w packages/core` — Single package
  - `cd packages/core && npx vitest run src/test/workGraph.test.ts` — Single file

**VS Code mocking:** The `vscode` module is aliased in each extension package's `vitest.config.ts` (core, github, ado, ai-reviewer, start-git-work — but not shared, which doesn't depend on vscode):
```typescript
// vitest.config.ts
alias: {
  vscode: path.resolve(__dirname, 'src/test/__mocks__/vscode.ts'),
}
```

All VS Code APIs (window, commands, events, etc.) are mocked in `__mocks__/vscode.ts` using `vi.fn()` and a custom `MockEventEmitter` class.

**Example test:**
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderRegistry } from '../services/providerRegistry';

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;
  
  beforeEach(() => {
    const stateStore = new DiscoveredStateStore(tmpDir);
    registry = new ProviderRegistry(stateStore);
  });

  it('registers a provider and returns a Disposable', () => {
    const provider = createMockProvider('test');
    const disposable = registry.register(provider);
    
    expect(registry.getProvider('test')).toBe(provider);
    disposable.dispose();
    expect(registry.getProvider('test')).toBeUndefined();
  });
});
```

### Build & Bundling

**Tool:** [esbuild](https://esbuild.github.io/)
**Format:** CommonJS (CJS) with external vscode module
**Entry point:** `src/extension.ts` → `dist/extension.js`

**Build commands:**
```bash
npm run build       # Debug with sourcemaps
npm run build:prod  # Minified with sourcemaps
npm run watch       # Watch mode
```

**Build flags:**
- `--bundle` — Bundle all dependencies into one file
- `--external:vscode` — Don't bundle vscode (it's provided by VS Code runtime)
- `--format=cjs` — CommonJS for Node.js/VS Code compatibility
- `--platform=node` — Node.js environment
- `--sourcemap` — Include source maps for debugging

### Type Safety & Shared Types

- The main public API surface lives in `packages/core/src/api/types.ts`, which defines key interfaces such as `DevDocketProvider`, `DevDocketAction`, and `DevDocketApi`
- `packages/core/src/api/types.ts` also re-exports selected shared types from `packages/shared/src/`
- Shared/reusable types include `DiscoveredItem`, `Disposable`, `Event`, `EventEmitterLike`
- Packages that define their own `tsconfig.json` (such as `packages/core/`) use strict TypeScript settings; `packages/shared/` does not have a per-package `tsconfig.json` and is consumed as shared source/types rather than built independently
- WorkItem state machine uses enums: `WorkItemState.New | InProgress | Paused | Done | Archived`

### Error Handling

- **Logging:** Use the `logger` instance from each package's local `logger` module (e.g., `import { logger } from '../services/logger'`). Each module creates its logger via `createLoggerService()` from `@devdocket/shared`.
- **Error recovery:** Log errors to the output channel but don't crash — use `.catch(err => logger.error(...))`
- **Store operations:** Return `Promise<void>` or `Promise<T>`; throw on unrecoverable errors (bad JSON, disk full)
- **Provider refreshes:** Wrap in try/catch, fire `onDidChangeProviderHealth` event on failure

**Example:**
```typescript
void provider.refresh().catch(err => {
  logger.error(`Provider ${provider.id} refresh failed`, err);
  this.healthStatus.set(provider.id, { status: 'unhealthy', lastError: err.message });
  this._onDidChangeProviderHealth.fire(provider.id);
});
```

### File Structure Conventions

- **Source code:** `src/` (TypeScript only, no compiled JS)
- **Built output:** `dist/extension.js` (gitignored)
- **Tests:** `src/test/**/*.test.ts` alongside source files
- **Mocks:** `src/test/__mocks__/` for VS Code and other external modules
- **Models:** `src/models/` for data structures (WorkItem, etc.)
- **Services:** `src/services/` for business logic (ProviderRegistry, WorkGraph, etc.)
- **Storage:** `src/storage/` for persistence layer with writeQueue pattern
- **Views:** `src/views/` for tree data providers and UI logic
- **API:** `src/api/` for public types that provider extensions consume

### Naming Conventions

- **Files:** camelCase (e.g., `workGraph.ts`, `jsonTaskStore.ts`)
- **Classes:** PascalCase (e.g., `WorkGraph`, `JsonTaskStore`, `ProviderRegistry`)
- **Interfaces:** PascalCase, optionally prefixed with `I` (e.g., `ITaskStore`)
- **Functions/methods:** camelCase (e.g., `createItem()`, `setState()`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `MAX_ITEMS_PER_PROVIDER = 10_000`)
- **Private members:** Generally camelCase without `_`; underscores are used selectively for established patterns such as private event emitters and some internal flags
- **Private event emitters:** Prefix with `_onDid` (e.g., `_onDidChangeDiscoveredItems`)
- **Public events:** Expose the corresponding event without the `_` prefix (e.g., `onDidChangeDiscoveredItems`)

## Examples

**Storage write with enqueue() and rollback:**
```typescript
async setState(providerId: string, externalId: string, state: InboxState, version?: string): Promise<void> {
  logger.debug(`Setting state for ${providerId}/${externalId} to ${state}`);
  await this.enqueue(async () => {
    if (!this.loaded) {
      await this.load();
    }
    const k = this.key(providerId, externalId);
    const previousValue = this.cache.get(k);
    const newRecord: DiscoveredStateRecord = { providerId, externalId, inboxState: state };
    if (version !== undefined) {
      newRecord.version = version;
    } else if (previousValue?.version !== undefined) {
      newRecord.version = previousValue.version;
    }
    if (previousValue?.resurfaceVersion !== undefined) {
      newRecord.resurfaceVersion = previousValue.resurfaceVersion;
    }
    this.cache.set(k, newRecord);
    try {
      await this.writeFile();
    } catch (err) {
      // Rollback cache on write failure
      if (previousValue) {
        this.cache.set(k, previousValue);
      } else {
        this.cache.delete(k);
      }
      throw err;
    }
  });
  this._onDidChange.fire();
}
```

**Provider with periodic refresh (using BaseProvider — ADO providers):**
```typescript
// ADO providers extend the shared BaseProvider (packages/shared/src/baseProvider.ts)
export class AdoWorkItemProvider extends BaseProvider {
  constructor(private readonly orgConfigs: OrgConfig[]) {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
  }

  async refresh(): Promise<void> { await this.doBackgroundRefresh(); }

  protected async doBackgroundRefresh(): Promise<void> {
    const items = await this.fetchWorkItems();
    this._onDidDiscoverItems.fire(items.map(wi => ({
      externalId: String(wi.id),
      title: wi.title,
      url: wi.url,
    })));
  }
}
```

**GitHub providers use their own base class:**
```typescript
// GitHub providers extend BaseGitHubProvider which implements DevDocketProvider
// directly (packages/github/src/baseGithubProvider.ts) — they do NOT extend
// the shared BaseProvider.
export class MyGitHubProvider extends BaseGitHubProvider {
  readonly id = 'my-github';
  readonly label = 'My GitHub Items';

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void> {
    const issues = await fetchIssues(accessToken);
    this._onDidDiscoverItems.fire(issues.map(issue => ({
      externalId: String(issue.number),
      title: issue.title,
      url: issue.html_url,
    })));
  }
}
```

**Test with mocked VS Code:**
```typescript
// Uses vitest alias to mock vscode module
import { vi } from 'vitest';
import * as vscode from 'vscode';  // Actually imports __mocks__/vscode.ts

describe('WorkItemEditorPanel', () => {
  it('creates a webview panel with correct title', () => {
    const panel = vscode.window.createWebviewPanel('test', 'Test', vscode.ViewColumn.One);
    
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'test',
      'Test',
      vscode.ViewColumn.One
    );
  });
});
```

## Anti-Patterns

- **Direct file I/O without writeQueue:** Don't use `fs.writeFileSync()` or multiple `await fs.writeFile()` calls in parallel. Always chain through `writeQueue`.
- **Persisting provider item data:** Don't cache title, description, or url from discovered items. Store only the external ID and inbox state. Fetch live data from the provider.
- **Ignoring vscode mock in tests:** Don't try to use the real vscode module in vitest tests. The alias prevents it. Always mock VS Code APIs in test setup.
- **Blocking the event loop:** Don't use synchronous operations (e.g., `JSON.stringify()` on huge objects) on the main thread. Keep stores responsive.
- **Creating stores without error handling:** All store operations should include try/catch and log errors via the logger service.
- **Unregistering providers without cleanup:** Always return a Disposable from `register()` that unsubscribes from the provider's onDidDiscoverItems event.

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
export class JsonTaskStore implements ITaskStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: Map<string, WorkItem> | null = null;

  async save(item: WorkItem): Promise<void> {
    // Chain new write onto the queue
    this.writeQueue = this.writeQueue.then(async () => {
      // Write to disk first, then update cache on success
      await fs.writeFile(this.filePath, JSON.stringify(...), 'utf-8');
      this.cache?.set(item.id, item);
    });
    
    return this.writeQueue;
  }
}
```

> **Note:** The actual implementation includes rollback logic and uses a private `enqueue()` helper. This example is simplified — refer to the real `JsonTaskStore` for error handling.

**When creating a new store:** Always include `private writeQueue: Promise<void> = Promise.resolve()` and chain all writes through it.

### Event-Driven Architecture

State changes follow a **mutate → save → fire → refresh** cycle. When a WorkItem state changes:
1. Mutate the in-memory object
2. Persist to disk via the store
3. Fire an `onDidChange` event
4. Providers refresh their discovered items
5. UI tree data providers refresh

**Example:** Moving a work item from Inbox to Queue:
```typescript
// In ProviderRegistry.acceptItem()
await this.stateStore.setState(providerId, externalId, 'accepted');
this._onDidChangeDiscoveredItems.fire();  // Providers and UI listen for this
```

### Provider Items: References, Not Copies

Items in the Inbox and Sources views are **live references** to the provider's in-memory data. Only the **inbox state enum** (`unseen | accepted | dismissed`) is persisted in `discovered-state.json`.

**Why:** Keeps data fresh. If a GitHub issue title changes, the UI immediately shows the latest title without needing to refetch or update persisted state.

**Pattern:**
```typescript
export interface DiscoveredStateRecord {
  providerId: string;
  externalId: string;
  inboxState: InboxState;  // Only this is stored
  version?: string;
}

// Item data (title, description, url) is always read live from provider:
export interface DiscoveredItem {
  externalId: string;
  title: string;  // Not persisted — always fresh from provider
  description?: string;
  url?: string;
  group?: string;
  reason?: string;
  version?: string;  // Version triggers resurfacing when changed
  resurfaceVersion?: string;  // Secondary version for independent resurfacing
}
```

### Monorepo Structure

```
packages/
  core/               — Main DevDocket extension (UI, work lifecycle, plugin API)
    src/
      services/      — ProviderRegistry, ActionRegistry, WorkGraph, logger
      storage/       — JsonTaskStore, DiscoveredStateStore, stores with writeQueue
      models/        — WorkItem state machine
      views/         — Tree data providers (Inbox, Queue, Focus, History, Sources)
      api/           — Public API types (DevDocketApi, DevDocketProvider)
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

**VS Code mocking:** The `vscode` module is aliased in each package's `vitest.config.ts`:
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

- All public API types live in `packages/shared/src/` and re-exported from `packages/core/src/api/types.ts`
- Reusable types: `DiscoveredItem`, `Disposable`, `Event`, `EventEmitterLike`
- Each package has its own `tsconfig.json` with strict mode enabled
- WorkItem state machine uses enums: `WorkItemState.New | InProgress | Paused | Done | Archived`

### Error Handling

- **Logging:** Use the shared `logger` service (injected or imported from `@devdocket/shared`)
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
- **Functions/methods:** camelCase (e.g., `createItem()`, `acceptItem()`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `MAX_ITEMS_PER_PROVIDER = 10_000`)
- **Private members:** Prefix with `_` (e.g., `_onDidChange`, `_disposed`)
- **Event emitters:** Prefix with `_onDid` (e.g., `_onDidChangeDiscoveredItems`)
- **Public events:** Remove `_` prefix (e.g., `onDidChangeDiscoveredItems`)

## Examples

**Storage write with writeQueue:**
```typescript
async setState(providerId: string, externalId: string, state: InboxState): Promise<void> {
  this.writeQueue = this.writeQueue.then(async () => {
    this.cache.set(this.key(providerId, externalId), { providerId, externalId, inboxState: state });
    await fs.writeFile(this.filePath, JSON.stringify(Array.from(this.cache.values())));
  });
  return this.writeQueue;
}
```

**Provider with periodic refresh (using BaseProvider):**
```typescript
export class GitHubProvider extends BaseProvider {
  constructor(private client: GitHubClient) {
    const emitter = new vscode.EventEmitter<DiscoveredItem[]>();
    super(emitter);
  }

  async refresh(): Promise<void> {
    const issues = await this.client.getIssues();
    this._onDidDiscoverItems.fire(issues.map(issue => ({
      externalId: String(issue.number),
      title: issue.title,
      url: issue.html_url,
      version: issue.updated_at,  // Resurface if issue changes
    })));
  }
}

// Usage:
const provider = new GitHubProvider(client);
provider.startPeriodicRefresh(300);  // Refresh every 5 minutes
api.registerProvider(provider);
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

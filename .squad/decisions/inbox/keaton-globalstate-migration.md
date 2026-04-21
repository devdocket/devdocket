# Architecture Decision: JSON File Stores vs. VS Code globalState Migration

**Issue:** [#304](https://github.com/devdocket/devdocket/issues/304) — Consider migrating JSON file stores to VS Code globalState API

**Date:** 2026-04-20

**Status:** RECOMMENDATION PENDING

---

## Executive Summary

DevDocket currently persists four distinct datasets (work items, discovered state, read state, provider label cache) as separate JSON files in `globalStorageUri`, each implementing shared infrastructure: write serialization, cache rollback, corruption recovery, and validation. VS Code's `context.globalState` API offers platform-managed SQLite-backed persistence with native atomicity and concurrent access handling.

**Recommendation:** **Option C — Hybrid Approach (Phased Migration)**

- Migrate **DiscoveredStateStore** and **ReadStateStore** to globalState (thin, stateless caches)
- Keep **JsonTaskStore** and **ProviderLabelCache** as JSON files (complex, debuggable)
- Benefit: Eliminate infrastructure duplication for simple stores, maintain debuggability and export capability for critical data

---

## Investigation Findings

### 1. Current State: Infrastructure vs. Business Logic

**Store Inventory:**

| Store | Purpose | Size | Complexity | Lines | Data Type |
|-------|---------|------|------------|-------|-----------|
| JsonTaskStore | WorkItem persistence | Complex | High | 242 | Array of rich objects |
| DiscoveredStateStore | Inbox state (unseen/accepted/dismissed) | Simple | Low | 259 | Array of thin records (providerId::externalId → state) |
| ReadStateStore | Read/unread tracking | Simple | Low | 145 | Set of composite keys |
| ProviderLabelCache | Provider label caching | Trivial | Very Low | 86 | Map of providerId → label string |
| **SerializedJsonStore** (base) | Write queue + file I/O | Shared Infrastructure | Medium | 99 | Reusable helpers |
| **limits.ts** | Size guards | Shared | Trivial | 6 | Constant |
| **validation.ts** | Field validators | Shared | Medium | 66 | Reusable utilities |

**Infrastructure Overhead Analysis:**

The **SerializedJsonStore base class** provides:
1. **Write Queue Serialization** (24 lines) — prevents concurrent file corruption via promise chain
2. **readJson()** (32 lines) — handles ENOENT, file type check, size limit (10 MB), JSON parse validation, corrupt file backup
3. **writeJson()** (4 lines) — creates directory recursively, writes pretty-printed JSON
4. **backupFile()** (8 lines) — safe backup with timestamp suffix

**Per-Store Overhead:**

- **JsonTaskStore:** 36 lines infrastructure (validation, caching, load deduplication), 206 lines business logic (WorkItem-specific)
- **DiscoveredStateStore:** 20 lines infrastructure, 239 lines business logic (multi-version tracking, event emitter)
- **ReadStateStore:** 40 lines infrastructure (dual-mode load/lazy), 105 lines business logic (Set operations)
- **ProviderLabelCache:** 30 lines infrastructure, 56 lines business logic

**Total infrastructure across all stores: ~170 lines of duplicated/specialized code**

### 2. globalState Capabilities

**What globalState Provides:**

- ✅ **Platform-managed persistence** — VS Code stores in SQLite via Memento API (per-extension, per-workspace scope)
- ✅ **Atomic writes** — no concurrent access issues, no corruption recovery needed
- ✅ **Async get/update/keys API** — fully async with Promise support
- ✅ **Type constraints** — values must be JSON-serializable (primitives, objects, arrays)
- ⚠️ **No size enforcement** — no hard limits documented, but reasonable (SQLite is embedded)

**Limitations:**

- ❌ **No key-value pair structure for complex queries** — API is flat key-value; querying by value requires loading all keys
- ❌ **No direct file access** — data is opaque to debugging/export; workarounds needed for user transparency
- ❌ **No version tracking** — application must handle migrations and schema changes
- ❌ **No validation layer** — application must validate on read; corrupt entries require manual recovery
- ❌ **Memento scope unclear** — documentation doesn't clarify exact SQLite structure (global vs. workspace)

**Size Analysis:**

- DevDocket WorkItems: ~20 items × ~1 KB = 20 KB (typical case)
- DiscoveredState: ~1,000 items × 100 bytes = 100 KB (GitHub issues + PRs)
- ReadState: ~500 items × 30 bytes (keys) = 15 KB
- ProviderLabelCache: ~5 items × 100 bytes = 1 KB
- **Total: ~136 KB typical, well below any reasonable SQLite limit**

globalState can handle DevDocket's data volumes with significant headroom.

---

## Migration Feasibility

### Store-by-Store Analysis

#### DiscoveredStateStore → globalState ✅ **Ideal Candidate**

**Why it works:**
- Thin records (providerId, externalId, inboxState enum only — no complex business logic)
- Read-heavy (providers query state frequently; writes happen on user action)
- No complex nested structure; composite keys are naturally flattened

**Migration:**
- Store each record as `key = providerId::externalId`, `value = { inboxState, version, resurfaceVersion }`
- Replace Map-based cache with async globalState.get(key) calls
- `setState()` / `setStates()` → `globalState.update(key, value)`
- Event emitter preserved for compatibility

**Test Impact:** Minimal — mock globalState.get/update/keys instead of file I/O

**Effort:** 1–2 days

#### ReadStateStore → globalState ✅ **Good Candidate**

**Why it works:**
- Simplest store (just a Set of string keys)
- Infrequent writes (only when user views inbox items)
- No validation needed; read operation never fails

**Migration:**
- Store as `key = read-state`, `value = string[]` (JSON-serializable array)
- Load once, keep in-memory Set cache for performance (same pattern as today)
- No events to emit

**Test Impact:** Straightforward — mock globalState.get/update

**Effort:** 1 day

#### JsonTaskStore → JSON Files ⚠️ **Keep as JSON**

**Why it should stay:**
- Complex data structure (WorkItem with activity log, many optional fields)
- Export/debugging critical — users may want to inspect/backup items as plain JSON
- Validation is extensive and critical to data integrity
- Rollback logic (save previous value before write) is intricate and well-tested

**Risks of migration:**
- Lose ability to copy `workitems.json` for backup
- Lose visibility into what items exist (opaque to file explorer)
- Validation/corruption recovery harder to test and debug
- Activity log entries require complex type checks; globalState validation would be ad-hoc

**Effort & Risk:** High — would require rewriting validation layer, losing debuggability, and replicating corruption recovery at app level

**Decision:** Keep as JSON file.

#### ProviderLabelCache → JSON Files ⚠️ **Keep as JSON**

**Why it should stay:**
- Cache is informational only (fallback exists: ask provider)
- Export use case: users might want to see cached labels without running extension
- Trivial size; JSON overhead not a concern

**Migration drawback:**
- globalState has no TTL/expiry mechanism; cache invalidation happens at app level anyway
- Current backupFile + corruption recovery is simple and proven

**Decision:** Keep as JSON file.

---

## Testing Impact

### Current Test Infrastructure

Tests use **vitest** with:
- Real filesystem (tmpdir) for JsonTaskStore, DiscoveredStateStore, ReadStateStore
- fs mocking (vi.mock('fs/promises')) for concurrency tests
- **No globalState mock** currently exists in `vscode.ts`

### Migration Testing Changes

**For globalState-migrated stores:**

1. **Add globalState mock to vscode.ts:**
   ```typescript
   class MockGlobalState {
     private data = new Map<string, unknown>();
     async get<T>(key: string, defaultValue?: T): Promise<T> { 
       return (this.data.get(key) ?? defaultValue) as T; 
     }
     async update(key: string, value: unknown): Promise<void> { 
       this.data.set(key, value); 
     }
     keys(): Promise<string[]> { 
       return Promise.resolve(Array.from(this.data.keys())); 
     }
   }
   ```

2. **Update DiscoveredStateStore tests:**
   - Replace tmpdir setup with mock globalState injection
   - Remove file I/O expectations; verify globalState.update() calls instead
   - Concurrency tests become simpler (no file write mocking needed)

3. **Update ReadStateStore tests:**
   - Similar pattern; inject mock globalState
   - Remove file teardown

4. **Test coverage:** No regression expected; same test cases, different I/O backend

**For JSON-based stores:**

- No changes to JsonTaskStore, ProviderLabelCache tests
- Continue using tmpdir + real file I/O
- Shared SerializedJsonStore base remains unchanged

**Effort:** 1–2 days for mock implementation and test updates

---

## Recommendation: Option C — Hybrid Approach

### Rationale

1. **Simplify infrastructure** — Remove 99-line SerializedJsonStore base + 170 lines of duplicated persistence code for thin caches
2. **Maintain debuggability** — Keep JSON export for WorkItems (most important data) and ProviderLabelCache (informational)
3. **Leverage platform** — Use globalState for cache-like data (DiscoveredState, ReadState) where atomicity is automatic
4. **Gradual, low-risk** — Migrate two small stores first; validate approach; keep critical JsonTaskStore untouched
5. **Reduce test complexity** — globalState mocks are simpler than file I/O mocking; no tmpdir cleanup needed

### Phase 1: Migrate Thin Caches (Week 1–2)

**Stores to migrate:** DiscoveredStateStore, ReadStateStore

**Tasks:**
1. Add globalState mock to vscode.ts (1 day)
2. Refactor DiscoveredStateStore to use globalState (1 day)
3. Refactor ReadStateStore to use globalState (0.5 days)
4. Update tests (1.5 days)
5. Validation & documentation (0.5 days)

**Success criteria:**
- All tests pass (no regression)
- Discovered state persists across restarts
- Read state persists across restarts
- No user-facing changes

### Phase 2: Defer or Evaluate (Post-MVP)

- Evaluate whether JsonTaskStore migration is needed (unlikely; no pain reported)
- If needed, consider moving to VS Code's workspaceState or custom globalState namespacing
- ProviderLabelCache remains JSON (low priority)

### Migration Path for Existing Data

**For DiscoveredStateStore:**
1. On activation, check if old `discovered-state.json` exists
2. If it does, read it and write to globalState in background
3. Delete old file after successful migration
4. Log success/failure

**For ReadStateStore:**
1. Same pattern: old `read-state.json` → globalState
2. Safe because data is non-critical (read state can be reset)

**For JsonTaskStore & ProviderLabelCache:**
- No migration needed; continue using JSON files

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| globalState scope unclear (global vs workspace) | Document scope decision; test across multi-workspace scenarios |
| No documented size limits | Monitor performance; add debug logging for globalState size |
| Data recovery from corrupted globalState | Keep migration logs; restore from backup JSON if needed (first 30 days) |
| Test mocking complexity | Implement simple mock first; iterate based on test failures |
| Partial migration creates inconsistency | Clear documentation of which stores use which backend |

---

## Non-Recommendations

### Option A: Keep All JSON ✗

**Why not:** Duplicates write-queue infrastructure, requires manual corruption recovery, misses platform-provided benefits

### Option B: Migrate All to globalState ✗

**Why not:**
- Loses debuggability (workitems.json is valuable for support/backup)
- Validation layer becomes app-level (error-prone)
- Export/import workflows harder (no plain-text data)
- Over-engineered for simple caches; simpler not always better

---

## Success Metrics

1. **Reduced code:** Remove 99-line SerializedJsonStore, 60+ lines of per-store infrastructure
2. **Maintained test coverage:** No drop in test count or quality
3. **No user-visible changes:** DiscoveredState and ReadState behavior identical
4. **Faster test runs:** globalState mocks simpler than file I/O; fewer tmpdir operations
5. **Easier debugging:** globalState stores transparent in VS Code's storage location

---

## Next Steps

1. **Code review:** Present this decision to team; collect feedback on globalState scope / size assumptions
2. **Validate globalState scope:** Write small proof-of-concept to confirm multi-workspace behavior
3. **Phase 1 implementation:** Assign to Fenster (backend) + Hockney (tests)
4. **Documentation:** Update storage.instructions.md with globalState patterns
5. **Deferred decisions:** Revisit JsonTaskStore migration post-MVP if needed

---

## References

- VS Code Memento API: https://code.visualstudio.com/api/references/vscode-api#globalState
- Issue #304: https://github.com/devdocket/devdocket/issues/304
- Current storage architecture: packages/core/src/storage/
- Test patterns: packages/core/src/test/

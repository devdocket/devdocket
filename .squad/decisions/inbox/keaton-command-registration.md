# Decision: Command Registration Architecture Review

**Date:** 2025-01-09  
**Lead:** Keaton  
**Issue:** #342 (Factor out command registration across extensions)  
**Status:** COMPLETE — Posted findings to issue

---

## Problem Statement

Issue #342 was triaged to Keaton (Lead) as vague and needing architectural analysis:
> "Each extension should be responsible for defining its own VS Code commands relevant to itself."

**Question:** Are commands currently misconfigured? Should providers (GitHub, ADO) own their own commands?

---

## Analysis Findings

### Current State (Correct ✅)

**Command Inventory:** 43 commands, all in core (`packages/core/src/commands/`)

| Package | Commands | Pattern |
|---------|----------|---------|
| core | 43 | Registers all via `registerCommands()` in extension.ts |
| github | 0 | Registers providers only via `api.registerProvider()` |
| ado | 0 | Registers providers only via `api.registerProvider()` |
| start-git-work | 0 | Registers action only via `api.registerAction()` |
| ai-reviewer | 0 | Registers action + chat/LM tools, no commands |

### Architecture Rationale

**Why commands belong in core:**
1. All commands operate on core's work item state model (WorkItem, WorkItemState)
2. All commands interact with core views (Inbox, Queue, Focus, History, Sources, Watches)
3. Provider items are ephemeral (read live from provider); only core maintains persistent state
4. Layout/view management commands are inherently core concerns
5. Watch tracking and activity logging are core lifecycle features

**Why providers don't register commands:**
1. Providers are pure discovery agents—no UI operations
2. Providers emit `DiscoveredItem[]` events; core consumes and manages them
3. Creating a "GitHub Open in GitHub" command is anti-pattern (command bloat)
4. Context menu actions are for core views, not provider-specific

**Why actions don't register commands:**
1. Actions are invoked programmatically via `devdocket.runAction` command
2. Actions have no user-facing commands of their own
3. Custom action behavior (git branches, code review) doesn't need command registration

---

## API Surface Review

**Current DevDocketApi (no command exposure):**
```typescript
interface DevDocketApi {
  registerProvider(provider: DevDocketProvider): Disposable;
  registerAction(action: DevDocketAction): Disposable;
  registerRunWatcher?(watcher: Watcher): Disposable;
  onDidTransitionState?(callback: (event: StateTransitionEvent) => void): Disposable;
  // ... etc (no registerCommand)
}
```

**Assessment:** ✅ Correct. Commands are internal implementation details, not API contracts.

---

## Risk Assessment

### No Breaking Changes Needed
- Current architecture is sound
- No refactoring required
- Extensions can continue using existing API

### Future Extensibility Considerations
If providers ever need commands (e.g., "Open in GitHub" context menu):
1. **Option A (Recommended):** Add provider-level action type that includes menu contributions
2. **Option B (If Needed):** Extend DevDocketApi with `registerCommand()` method
3. **Option C (Not Recommended):** Provider self-registration (defeats the point of core hub)

---

## Recommendations

### Phase 1: Documentation (Low Effort, High Clarity)
Add `packages/core/src/commands/README.md`:
- List commands by view/concern
- Explain why all commands are in core
- Document how to add new commands

### Phase 2: Optional Command Registry (Medium Effort)
Create `commandRegistry.ts` for machine-readable ownership:
- Enable automated tests (all package.json commands have handlers)
- Generate documentation from registry
- Track command dependencies on services

### Phase 3: If Needed — API Extension
Only if providers need commands:
- Design provider action menus
- Extend DevDocketApi.registerCommand() if necessary
- Update type surface accordingly

---

## Outcome

✅ **Not a bug.** Current command registration is well-designed.

**GitHub Issue Recommendation:** Close as `status:working-as-intended` with Phase 1 documentation as optional enhancement.

**Team Impact:** 
- No code changes needed
- Documentation clarity may help with future feature work
- Current design scales well to additional providers/actions

---

## Decision Record

| Aspect | Decision |
|--------|----------|
| Are commands in wrong place? | ✅ No — correct scope |
| Do providers need commands? | ❌ No — discovery is API-driven |
| Do actions need commands? | ❌ No — invoked programmatically |
| API changes needed? | ❌ No |
| Code refactoring needed? | ❌ No (optional: documentation) |
| Recommendation | Keep as-is; add Phase 1 docs for clarity |

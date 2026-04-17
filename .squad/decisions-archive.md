# Squad Decisions — Archive

> Archived decisions older than 30 days. Preserved for reference. See `decisions.md` for active decisions.

---

### ADO State-Category-Based Filtering (2025-01-22)

**Author:** Fenster (Extension Dev)  
**Status:** Implemented

Azure DevOps work item states vary by process template (Agile, Scrum, CMMI, custom). Previously, the ADO provider hardcoded state exclusions in the WIQL query, which was fragile across different templates.

**Decision:** Implement two-layer filtering using ADO's **Work Item Type States API** to dynamically determine terminal states based on their **category**:

1. **Layer 1 (WIQL):** Exclude common terminal states (`Closed`, `Removed` only) for performance, preventing thousands of old work items from being fetched.

2. **Layer 2 (State Category API):** After fetching work item details, call the states API for each unique `(project, workItemType)` pair and filter out items where `System.State` is in a terminal category (`Completed`, `Removed`, `Resolved`).

**Implementation Details:**
- Cache key: `{project}/{workItemType}` — survives multiple refresh cycles
- Terminal categories: `Completed`, `Removed`, `Resolved`
- Fail-open pattern: If states API fails, return empty set (no filtering applied for that type)
- URL-encoding: Applied to org, project, and workItemType for API safety

**Rationale:**
- Works across all process templates without hardcoding state names
- WIQL filtering reduces initial data volume; states API provides correctness
- Fail-open ensures extension remains usable if metadata is unavailable
- Caching prevents redundant API calls for same work item type within refresh cycle

**Test Coverage:** 9 new tests + 16 pre-existing test fixes  
**Result:** All 132 ADO tests pass, 1124 total tests pass

**References:**
- Issue #178
- `packages/ado/src/adoWorkItemProvider.ts`
- ADO REST API: [Work Item Type States](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-type-states/list)

---

### GitHub Package vscode Mock (2026-01-24)

**Author:** Fenster (Extension Dev)  
**Status:** Implemented

Created `packages/github/src/test/__mocks__/vscode.ts` extending the core mock with:
- `authentication.getSession` — returns `{ accessToken: 'mock-token' }`
- `workspace.getConfiguration` — returns `.get(key, default)` stub
- `workspace.workspaceFolders` — workspace folder detection
- `extensions.getExtension` — core extension dependency lookup
- `commands.executeCommand` — covers `vscode.openFolder`
- `Uri.file` — worktree URI creation
- `window.showErrorMessage` — error dialogs

**Rationale:** Each package owns its own test infrastructure to avoid coupling. Explicit mocking required since vscode is external.

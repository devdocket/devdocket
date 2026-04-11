# Decisions Log

## Security Bugfix Batch — 2026-04-09

### Decision: Validate custom prompt paths against workspace boundaries

**Author:** Fenster  
**Date:** 2026-07-14  
**Issue:** #152  

#### Context
The `resolvePromptUri` method accepted any file path from VS Code settings without validating it was within the workspace. A malicious `.vscode/settings.json` could point `customPromptPath` to any file on disk (e.g., `~/.ssh/id_rsa`), whose contents would be read and sent to an LLM.

#### Decision
Both absolute and relative paths are now validated to resolve within a workspace folder. Paths outside the workspace are rejected with a clear error message that surfaces to the user.

#### Alternatives Considered
1. **Reject absolute paths entirely** — simpler but less flexible for monorepo setups where the prompt file is in a shared location within the workspace.
2. **Allowlist file extensions** (e.g., `.md` only) — doesn't prevent reading sensitive `.md` files outside workspace.
3. **Current approach: containment check** — resolves the path, normalizes it, and verifies it starts with a workspace folder prefix. Works for both absolute and relative paths, handles `..` traversal, and is case-insensitive on Windows.

#### Impact
- **Tests:** 6 tests that relied on the old insecure behavior need updating by Hockney — they should use paths within the mock workspace (`/mock/workspace/...`).
- **Users:** Custom prompt paths that pointed outside the workspace will now show a validation error and fall back to the built-in prompt.

---

### Decision: Graceful corruption recovery in ReadStateStore

**Issue:** #153
**Author:** Fenster
**Date:** 2026-07-14

#### Context
ReadStateStore threw on corrupted JSON, while jsonTaskStore and discoveredStateStore backed up the file and reset to empty. This inconsistency meant corrupted read-state would crash the extension on startup.

#### Decision
Changed ReadStateStore to match the backup-and-reset pattern used by the other two stores. Also added a shared 10 MB file size limit (`MAX_STORE_FILE_SIZE` in `limits.ts`) enforced before `JSON.parse` in all three stores.

#### Consequence
- The test `should handle corrupted JSON by throwing` now fails because the behavior intentionally changed from throw → graceful recovery. Hockney needs to update it.
- All three stores now behave consistently on corruption: backup the file, log a warning, reset to empty.

---

### Decision: Trust boundary validation approach for Plugin API

**Date:** 2026-07-14
**Author:** Fenster
**Issue:** #157

#### Context
The plugin API (registerProvider, registerAction) has no caller identity verification — any extension can register with any ID. Provider data is unbounded, and actions receive mutable WorkItem objects.

#### Decision
1. **Provider ID squatting** — Document the trust model rather than attempt runtime verification (VS Code provides no caller context). Elevate registration logs from `info` to `warn` for admin auditability.
2. **Unbounded provider data** — Enforce `MAX_ITEMS_PER_PROVIDER = 10,000` at the ingestion boundary in `handleDiscoveredItems`. Truncate silently (after logging a warning) rather than rejecting the entire batch.
3. **Action data access** — Use `Readonly<WorkItem>` in the `WorkCenterAction` interface to prevent accidental mutation. This is compile-time only (no runtime freeze), which is acceptable for the extension-to-extension trust level.

#### Alternatives Considered
- **Runtime Object.freeze** on WorkItem before passing to actions — rejected as unnecessary overhead; TypeScript's type system is sufficient for the cooperative trust model between VS Code extensions.
- **Rejecting oversized batches entirely** — rejected in favor of truncation to avoid losing valid data when a provider slightly exceeds the limit.
- **Extension identity verification** — not feasible with current VS Code API; would require upstream changes.

#### Impact
Core package only. No changes to provider extensions (github, ado, ai-reviewer) — their re-declared types are structurally compatible.

---

### Decision: Use native URL constructor for scheme validation

**Date:** 2026-07-14
**Issue:** #155
**Author:** Fenster

#### Context
The `handleOpenInBrowser` command passes URLs to `vscode.env.openExternal()`. The existing inline check used `vscode.Uri.parse(url).scheme` to validate http/https, but this doesn't catch malformed URLs.

#### Decision
Extracted a standalone `isSafeUrl(url: string): boolean` helper that uses the native `URL` constructor with try/catch. This:
1. Rejects malformed URLs (try/catch on `new URL()`)
2. Validates protocol is `http:` or `https:` only
3. Works in both VS Code and plain Node.js (no vscode mock needed for tests)

#### Alternatives Considered
- **Keep inline `vscode.Uri.parse` check:** Works but `vscode.Uri.parse` doesn't throw on invalid input — it silently parses garbage strings, which could lead to unexpected behavior.
- **Regex-based validation:** Fragile and hard to maintain for edge cases.

#### Impact
- Blocks dangerous protocols (`data:`, `file:`, `javascript:`, etc.)
- Helper is reusable if other commands need URL validation in the future

---

## Decision: Remove resurfaceDismissed — Dismissed Items Stay Dismissed

**Author:** Fenster (Extension Dev)  
**Date:** 2025-01-24  
**Issue:** #189  
**Status:** Implemented

### Context

PR review providers (`GitHubPrReviewProvider`, `AdoPrReviewProvider`) had `resurfaceDismissed = true`, which caused `handleDiscoveredItems()` to overwrite dismissed items back to `unseen` on every provider refresh. This made it impossible for users to permanently dismiss PR review requests from their Inbox.

### Decision

Remove the `resurfaceDismissed` feature entirely. Dismissed items should **never** be resurfaced by any provider. This aligns with the original four-view architecture decision that "dismissed items are sticky."

### What Changed

- Removed `resurfaceDismissed` from `WorkCenterProvider` interface in core, github, ado, and ai-reviewer packages
- Removed the resurface logic from `ProviderRegistry.handleDiscoveredItems()`
- Removed the property from `BaseGitHubProvider`, `GitHubPrReviewProvider`, and `AdoPrReviewProvider`
- Removed all related tests and documentation
- Also reverted an incorrect prior fix (defensive `await stateStore.load()`) that addressed a non-existent race condition

### Rationale

- **User intent is clear**: When a user dismisses an item, they do not want to see it again. Resurfacing violated this expectation.
- **Design consistency**: The four-view model's core invariant is that dismissed = permanent. Adding exceptions per-provider creates confusion.
- **Simplicity**: Providers should not need to opt into behavioral variations of the inbox state machine. One behavior, no flags.

### Alternatives Considered

- **Keep resurfaceDismissed but default to false**: Still adds complexity to the provider API for a feature no one wants.
- **Add a "snooze" state instead**: Possible future work if users want temporary dismissal, but should be a separate state (`snoozed`) rather than overloading `dismissed`.

### Impact

- 13 files changed, ~500 lines removed
- All 1174 tests pass
- No breaking changes for existing providers (the removed property was optional)

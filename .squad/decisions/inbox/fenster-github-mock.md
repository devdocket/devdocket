# Decision: GitHub package vscode mock design

**Date:** 2025-01-24
**Author:** Fenster (Extension Dev)
**Status:** Accepted

## Context

The `packages/github/` extension needs a vitest-compatible vscode mock to enable unit testing. The core package already has a working mock at `packages/core/src/test/__mocks__/vscode.ts`.

## Decision

Created `packages/github/src/test/__mocks__/vscode.ts` by extending the core mock with github-specific API surfaces:

- **`authentication.getSession`** — defaults to resolving `{ accessToken: 'mock-token' }`, covers GitHub auth flow in `githubProvider.ts`
- **`workspace.getConfiguration`** — returns object with `.get(key, default)` stub, covers config reads in `githubProvider.ts` and `extension.ts`
- **`workspace.workspaceFolders`** — default property for `startWorkAction.ts` workspace detection
- **`extensions.getExtension`** — returns `{ isActive: true, exports: {}, activate: vi.fn() }` for core extension dependency lookup in `extension.ts`
- **`commands.executeCommand`** — covers `vscode.openFolder` call in `startWorkAction.ts`
- **`Uri.file`** — covers worktree URI creation in `startWorkAction.ts`
- **`window.showErrorMessage`** — covers error dialogs in `startWorkAction.ts`

## Alternatives Considered

- **Shared mock between packages**: Rejected — the packages have different API surface needs, and a shared mock would couple them unnecessarily. Each package owns its own test infra.
- **Auto-mocking via vitest**: Rejected — `vscode` is an external module not installable via npm; explicit mocking is required.

## Consequences

- Tests in the github package can now be written with full vscode API coverage.
- Mock defaults are sensible for happy-path tests; individual tests can override via `vi.mocked()`.
- If new vscode APIs are used in github source files, the mock must be updated to match.

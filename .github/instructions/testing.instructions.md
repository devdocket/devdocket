---
applyTo: "**/*.test.ts,**/test/**"
---

# Testing Conventions

## Running Tests

```bash
# Test all packages
npm run test

# Test a single package
cd packages/core && npm run test

# Run a single test file
cd packages/core && npx vitest run src/test/workGraph.test.ts
```

## vscode Module Mocking

Tests run outside VS Code via **vitest**. The `vscode` import is aliased to a mock module in each package's `vitest.config.ts`:

- **Core:** `packages/core/src/test/__mocks__/vscode.ts`
- **GitHub:** `packages/github/src/test/__mocks__/vscode.ts`

The alias is configured in `vitest.config.ts` under `resolve.alias`, mapping `'vscode'` to the mock file path.

### Adding New VS Code API Mocks

When you use a new VS Code API in source code, you **must** add a corresponding mock in the relevant `__mocks__/vscode.ts` file. Otherwise tests will fail with undefined imports.

Common mock patterns already present:
- `window.showInputBox`, `window.showQuickPick`, `window.showErrorMessage`
- `commands.registerCommand`, `commands.executeCommand`
- `workspace.getConfiguration` (returns `.get(key, default)` stub)
- `authentication.getSession` (resolves with `{ accessToken: 'mock-token' }`)
- `Uri.file`, `Uri.parse`
- `EventEmitter` (with `event`, `fire`, `dispose`)
- `TreeItem`, `ThemeIcon`, `MarkdownString`

## Vitest Conventions

- All test files use the `.test.ts` extension.
- Tests are co-located under `src/test/` in each package.
- Use `describe` / `it` blocks with clear descriptions.
- Use `beforeEach` to reset shared state between tests.

# Decision: Rename DevDocket → DevDocket

**Date:** 2025-07-16
**Author:** Fenster (Extension Dev)
**Requested by:** Matt Thalman

## Context
The project is being rebranded from "DevDocket" to "DevDocket". This required a codebase-wide mechanical rename across all source files, package manifests, extension IDs, command prefixes, and documentation.

## Approach
- Used an ordered find-and-replace strategy (most-specific patterns first) to prevent partial-match corruption.
- Applied 24 replacement patterns covering PascalCase, camelCase, kebab-case, scoped packages, and extension IDs.
- Renamed 3 files via `git mv` (SVG icon, API source, API test).
- Skipped `.squad/` files, `node_modules/`, `.git/`, and `package-lock.json`.

## Result
- 80 files changed, all 167 tests pass, build succeeds.
- No remaining "devdocket" or "DevDocket" references in tracked source files.

## Team Impact
- All extension IDs now use `devdocket` prefix (e.g., `mthalman.devdocket`, `mthalman.devdocket-github`).
- Package names updated (e.g., `@devdocket/shared`).
- API types renamed: `DevDocketApi`, `DevDocketProvider`, `DevDocketAction`.
- `.squad/` files still reference old name and need separate update.

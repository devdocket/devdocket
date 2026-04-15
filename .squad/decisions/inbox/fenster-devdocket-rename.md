# Decision: Rename WorkCenter → DevDocket

**Date:** 2026-04-15
**Author:** Fenster (Extension Dev)
**Requested by:** Matt Thalman

## Context
The project is being rebranded from "WorkCenter" to "DevDocket". This required a codebase-wide mechanical rename across all source files, package manifests, extension IDs, command prefixes, and documentation.

## Approach
- Used an ordered find-and-replace strategy (most-specific patterns first) to prevent partial-match corruption.
- Applied 24 replacement patterns covering PascalCase, camelCase, kebab-case, scoped packages, and extension IDs.
- Renamed 3 files via `git mv` (SVG icon, API source, API test).
- Updated `.squad/` files, all source packages, and documentation. Excluded `node_modules/` and `.git/`.

## Result
- 93 files changed across all packages, docs, and `.squad/` files. All tests pass, build succeeds.
- No remaining "workcenter" or "WorkCenter" references in tracked source, documentation, or `.squad/` files. Some non-source metadata (e.g., stale lockfile entries) may retain historical references.

## Team Impact
- All extension IDs now use `devdocket` prefix (e.g., `mthalman.devdocket`, `mthalman.devdocket-github`).
- Package names updated (e.g., `@devdocket/shared`).
- API types renamed: `DevDocketApi`, `DevDocketProvider`, `DevDocketAction`.
- `.squad/` files updated to reflect the new name.

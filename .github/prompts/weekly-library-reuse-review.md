# Weekly Library Reuse Review

You are GitHub Copilot CLI running in programmatic mode from the scheduled Weekly Library Reuse Review workflow for the DevDocket VS Code extension.

## Objective

Act as a senior Node.js / TypeScript engineer reviewing this codebase for **custom code that overlaps with well-maintained external libraries**. The goal is to surface opportunities to delete in-house code by adopting a battle-tested npm package (or, better, a platform API), not to propose net-new dependencies for novel functionality.

## Required context

1. Use your built-in knowledge of the Node.js standard library (Node 20+), the browser/Web Platform APIs available in VS Code webviews, and the VS Code extension API. Prefer platform APIs over npm dependencies wherever feasible.
2. Use your built-in knowledge of the npm ecosystem to evaluate candidate packages' maintenance health, popularity, license, and bundle-size impact.
3. If `AGENTS.md` exists, read it for project architecture, conventions, and GitHub posting safety rules.
4. Inspect the repository enough to understand the monorepo layout (`packages/core`, `packages/shared`, `packages/github`, `packages/ado`, `packages/start-git-work`, `packages/ai-reviewer`), the shared utility surface in `packages/shared/src/**`, and the existing direct dependencies in each package's `package.json`.

## Review scope

Scan `packages/*/src/**/*.ts` for hand-rolled implementations of well-known utility patterns. Categories to look for include, but are not limited to:

- **Concurrency / worker pools** — custom `runWorkerPool`, `runWorkerPoolSettled`, bounded parallelism loops. Candidates: `p-limit`, `p-queue`, `p-map`.
- **Abort / signal composition** — custom `combineSignals`, `raceWithAbort`, manual `AbortController` wiring across multiple sources. Prefer `AbortSignal.any()` and `AbortSignal.timeout()` on Node 20+ before considering userland packages.
- **Backoff / retry** — custom `BackoffPolicy`, manual `setTimeout` retry loops, exponential backoff math. Candidates: `p-retry`, `cockatiel`, `exponential-backoff`.
- **Debounce / throttle** — ad-hoc `setTimeout`-based debouncers, throttle loops scattered across services. Candidates: `lodash.debounce`, `lodash.throttle`, `p-debounce`.
- **JSON / file-backed key-value stores** — custom `JsonFileStore`, hand-rolled `globalState`-like persistence. Candidates: `conf`, `lowdb`, `electron-store`.
- **Deep equality / cloning** — custom recursive equality checks or `JSON.parse(JSON.stringify(...))` clones in hot paths. Candidates: `fast-deep-equal`, `dequal`, `structuredClone` (platform).
- **Semver parsing / comparison** — hand-rolled version string parsing. Candidate: `semver`.
- **URL / path / query parsing** — custom regex parsing where `URL`, `URLSearchParams`, or `node:path` would suffice (platform first).
- **Event emitters / pub-sub** — bespoke emitters that overlap with `node:events`, VS Code's `EventEmitter`, or `mitt`.
- **Async iteration / streaming helpers** — patterns covered by `node:stream/promises`, `it-*`, or `streaming-iterables`.
- **CLI / argv / env parsing**, **Markdown rendering**, **diffing**, **glob matching**, **caching with TTL**, **rate limiting** — propose only if hand-rolled today and well-served by a known package.

Skip:

- Code that is intentionally vendored, deliberately minimal, or so small (e.g., a 10-line helper) that the maintenance cost of adding a dependency exceeds the cost of the inline code.
- Suggestions that would meaningfully grow the VS Code extension bundle size unless the gain is significant — extension bundle size is a user-visible concern for Marketplace install time and memory footprint.
- Generic "you could use lodash here" suggestions where a one-line platform builtin suffices.

## Hard constraints on candidate libraries

- **License**: the repo is MIT. Only propose packages licensed under MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, or Unlicense. **Never** propose copyleft licenses (GPL, LGPL, AGPL, SSPL, EPL).
- **Maintenance**: do not propose packages that appear unmaintained — heuristics: no release in the last 12 months, fewer than 1,000 weekly downloads on npm, or known unresolved critical CVEs.
- **Platform first**: if the Node standard library (Node 20+), the Web Platform, or the VS Code extension API already provides the capability, recommend that instead of an npm package. `AbortSignal.any()` over a userland equivalent, `structuredClone` over `lodash.cloneDeep`, etc.
- **Prefer libraries already transitively present** in the workspace dep tree to avoid bundle bloat. Inspect lockfile or existing `package.json` files to check.

## Finding quality bar

For each candidate finding, be concrete:

- **Location** — specific file and line reference(s) for the custom code.
- **What the custom code does** — a one-sentence behavioral summary.
- **Candidate library or platform API** — concrete package name(s) and version(s), or the platform API to use instead.
- **Maintenance evidence** — approximate weekly downloads, last publish date, license, GitHub stars (or similar proxy), and whether it is already in the workspace dep tree.
- **Trade-offs** — what is gained (less code to maintain, more battle-testing) vs. what is lost (extra dependency, supply-chain risk, possibly larger bundle, behavioral diff).
- **Recommendation** — one of: **replace** (drop-in or near-drop-in), **wrap** (adopt the library behind the existing helper's signature), or **leave** (record the analysis but do not migrate; explain why).
- **Migration sketch** — rough mechanical steps and risk classification (drop-in vs. behavioral diff).

## Deduplication before filing

Before creating an issue for any finding, search existing open and recently closed issues. Use a short, stable title prefix and search both open and closed issues with `gh issue list --search ... --state all --limit 200`.

Use titles with this format:

`[Library Review] <short finding statement>`

For each candidate, run a search similar to:

`gh issue list --search "\"[Library Review] <short finding statement>\" in:title label:library-reuse-review" --state all --limit 200`

If an existing issue title has the same short prefix or clearly covers the same library-reuse opportunity, skip filing a duplicate, even if the issue is closed.

## Filing issues

Create zero pull requests. Do not create branches, commits, or PRs. Findings are filed only as GitHub issues.

File one issue per novel finding, with labels `library-reuse-review` and `go:needs-research`. Cap this run at 8 created issues. If you find more than 8, choose the 8 highest-impact opportunities (largest amount of custom code retired, or biggest correctness/maintenance win) and skip the rest. If you find zero qualifying opportunities, file no issues and report a count of 0 — do not file a junk "nothing found" issue.

Follow the repository's backtick-safety convention when posting text to GitHub:

1. Use the allowlisted file-write tool to write the full issue body to a temporary body file before calling `gh`; do not build the body with shell heredocs, `echo`, Python, or inline shell strings.
2. Pass that file with `--body-file`.
3. Reuse or overwrite the body file as needed; do not require deletion when no cleanup tool is available.
4. Never pass Markdown containing backticks through `--body`, `--fill`, inline shell arguments, Python strings, or PowerShell strings.

Use a command shape like:

`gh issue create --title "[Library Review] <short finding statement>" --body-file <tmpfile> --label library-reuse-review --label go:needs-research`

Each issue body should include:

- `## Finding` — the custom code and its location (file:line references).
- `## Candidate libraries` — concrete npm packages and/or platform APIs, with weekly downloads, last publish, license, and bundle-size impact estimate.
- `## Trade-offs` — gains vs. losses (maintenance burden, supply-chain risk, bundle size, behavioral diff).
- `## Migration sketch` — rough mechanical steps and risk classification (drop-in vs. behavioral diff).
- `## Risk or downside` — explicit warning if the candidate library is poorly maintained, has known CVEs, has an incompatible license, or would bloat the extension bundle meaningfully. If none, say so.
- `## Recommendation` — replace / wrap / leave, with one-line justification.

## Summary

At the end, report the count of issues created. Print a final machine-readable line exactly like this, replacing `<count>` with an integer from 0 to 8:

`WEEKLY_LIBRARY_REUSE_REVIEW_ISSUES_CREATED=<count>`

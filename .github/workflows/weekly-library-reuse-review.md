---
description: "Scheduled review of the DevDocket codebase for custom code that overlaps with well-maintained npm packages or platform APIs."
on:
  schedule:
    # Every Friday at 10:00 AM UTC
    - cron: "0 10 * * 5"
  workflow_dispatch:
concurrency:
  group: weekly-library-reuse-review
  cancel-in-progress: true
permissions:
  contents: read
  issues: read
  pull-requests: read
engine: copilot
safe-outputs:
  create-issue:
    title-prefix: "[Library Review] "
    labels: [library-reuse-review, automated, go:needs-research]
    max: 8
    deduplicate-by-title: true
---

# Weekly Library Reuse Review

You are an AI coding agent running from the scheduled Weekly Library Reuse Review GitHub Agentic Workflow for the DevDocket VS Code extension.

## Objective

Act as a senior Node.js / TypeScript engineer reviewing this codebase for **custom code that overlaps with well-maintained external libraries**. The goal is to surface opportunities to delete in-house code by adopting a battle-tested npm package (or, better, a platform API), not to propose net-new dependencies for novel functionality.

## Required context

1. Use your built-in knowledge of the Node.js standard library (Node 20+), the browser/Web Platform APIs available in VS Code webviews, and the VS Code extension API. Prefer platform APIs over npm dependencies wherever feasible.
2. Use your built-in knowledge of the npm ecosystem to evaluate candidate packages' maintenance health, popularity, license, and bundle-size impact.
3. If `AGENTS.md` exists, read it for project architecture and conventions.
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

## Filing findings

For each novel finding, request a new GitHub issue by invoking the `create_issue` tool. The workflow automatically prepends `[Library Review] `, applies the labels `library-reuse-review`, `automated`, and `go:needs-research`, and dedups against existing issues with the same prefixed title, so you do not need to add the prefix, labels, or perform manual dedup yourself. Cap this run at 8 issues. If you find more than 8, choose the 8 highest-impact opportunities (largest amount of custom code retired, or biggest correctness/maintenance win) and skip the rest. If you find zero qualifying opportunities, request no issues — do not file a junk "nothing found" issue.

For each issue you request, use these sections in this order:

- `## Finding` — the custom code and its location (file:line references).
- `## Candidate libraries` — concrete npm packages and/or platform APIs, with weekly downloads, last publish, license, and bundle-size impact estimate.
- `## Trade-offs` — gains vs. losses (maintenance burden, supply-chain risk, bundle size, behavioral diff).
- `## Migration sketch` — rough mechanical steps and risk classification (drop-in vs. behavioral diff).
- `## Risk or downside` — explicit warning if the candidate library is poorly maintained, has known CVEs, has an incompatible license, or would bloat the extension bundle meaningfully. If none, say so.
- `## Recommendation` — replace / wrap / leave, with one-line justification.

Do not create pull requests, branches, or commits.

## Wrap-up

Conclude with a short plain-text summary of how many issues you requested and any concerns that did not meet the quality bar.

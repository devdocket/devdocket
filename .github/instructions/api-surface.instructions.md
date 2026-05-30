---
applyTo: "packages/core/src/api/**,packages/shared/src/**,packages/core/src/models/**"
---

# Extension API Breaking Change Detection

Any change to the public API surface **must** be evaluated for breaking changes during code review. Breaking changes must be flagged as **Critical** findings with the label `[API BREAKING CHANGE]`.

## Public API Surface Files

These files define the contract that provider extensions depend on:

- `packages/core/src/api/types.ts` — `DevDocketApi`, `DevDocketProvider`, `DevDocketAction`, and re-exported shared types (`Disposable`, `Event`, `ProviderItem`)
- `packages/core/src/models/workItem.ts` — `WorkItem` and `WorkItemState` (exposed to action implementors via `DevDocketAction.canRun` / `run`)
- `packages/shared/src/baseProvider.ts` — `ProviderItem`, `Disposable`, `Event`, `EventEmitterLike`, `BaseProvider`
- `packages/shared/src/index.ts` — all symbols exported from this barrel are public API surface of `@devdocket/shared`

## What Constitutes a Breaking Change

Any of the following applied to an exported interface, type, class, or function is a **breaking change**:

1. **Removing** a method, property, exported symbol, or enum member.
2. **Renaming** an exported symbol or enum member (type, interface, function, class, constant, enum value).
3. **Adding a required parameter** to an existing method or function (optional is safe).
4. **Changing the type** of an existing parameter, property, or return value in a way that is not a supertype widening.
5. **Changing an interface from optional to required** for any property (e.g. `foo?: string` → `foo: string`).
6. **Removing a re-export** from `packages/shared/src/index.ts` or `packages/core/src/api/types.ts`.
7. **Changing generic type parameters** (adding required generics, removing generics, changing constraints).
8. **Moving an exported symbol** to a different module path without preserving the old path as a re-export.

**Usually not breaking**: adding new optional properties, adding new exported symbols, adding new interfaces/types, widening an existing parameter type to a supertype, or adding new overload signatures only when they are appended and do not overlap with existing overload resolution. **Note:** widening a return type is often breaking for TypeScript consumers.

## Code Review Requirements

- The reviewer **must** check all changed files against the API surface list above.
- Any detected breaking change **must** be reported as a **Critical** finding with the label `[API BREAKING CHANGE]`.
- If a breaking change is **intentional**, the PR description **must** include a `## Migration Notes` section documenting:
  - Which interfaces/types/exports changed and how.
  - What provider extensions need to update (code examples preferred).
  - The justification for the break.
- If a breaking change is found and the PR description lacks migration notes, the reviewer **must** block the PR and request they be added.

The `superpowers:code-reviewer` agent enforces this policy automatically; manual reviewers should follow the same checklist.

## Bumping CONTRACT_VERSION

The runtime contract version is the `CONTRACT_VERSION` constant in `packages/shared/src/contractVersion.ts`. It is exposed to provider extensions at runtime via `DevDocketApi.contractVersion` and is the value compared against `DevDocketProvider.minContractVersion` / `DevDocketAction.minContractVersion`. Whenever the public API surface defined above changes, this constant **must** be updated in the same PR so provider extensions can gate behavior correctly.

### When to bump

The bump semantics mirror the breaking-change rules above:

- **patch** — pure internal/non-contract fixes (implementation bug fixes, perf improvements, refactors) that add, remove, or rename nothing observable on the API surface. In most cases these changes do **not** require a `CONTRACT_VERSION` bump at all — providers gating on a version cannot meaningfully detect a non-contract fix. Do not bump needlessly. Bump patch only when a behavioral fix is observable through the existing surface and providers might reasonably want to gate on it.
- **minor** — any additive change to the API surface: a new optional property, a new method, a new exported type or interface, a new enum member, a new appended overload, or any new capability that providers can opt into via `minContractVersion`. Bump minor.
- **major** — any breaking change (see "What Constitutes a Breaking Change" above). Bump major. The PR description **must** also contain a `## Migration Notes` section per the existing policy.

### How to bump

- Edit `CONTRACT_VERSION` in `packages/shared/src/contractVersion.ts` in the **same PR** as the surface change. Never defer to a follow-up — provider extensions cannot gate on a version that has not shipped.
- The npm `version` field in `packages/shared/package.json` and the `.changeset/*.md` entry are managed separately by Changesets and **must not** be edited by hand. `CONTRACT_VERSION` is the *runtime contract version* the core extension advertises to provider extensions; the npm version of `@devdocket/shared` tracks the package as a whole (including internal helpers, perf fixes, and other non-contract code). They will often move together but are independent numbers — do not assume one implies the other.

### Reviewer responsibility

- Code review (and the `superpowers:code-reviewer` agent) **must** verify that any qualifying API surface change includes a matching `CONTRACT_VERSION` bump.
- A missing or incorrect bump on a minor or major surface change is a **Critical** finding. Label it `[CONTRACT VERSION NOT BUMPED]`.
- A bump that does not match the actual surface change (e.g., major bump for a purely additive change, or minor bump for a breaking change) is also a **Critical** finding under the same label.

### Tests

When adding a new optional capability gated on `minContractVersion`, the corresponding tests should demonstrate `isContractVersionSatisfied` returning `false` for the previous version and `true` for the new one. See the existing tests in `packages/shared/src/test/contractVersion.test.ts` for the pattern — a brief reference is sufficient, no need to duplicate the full example here.

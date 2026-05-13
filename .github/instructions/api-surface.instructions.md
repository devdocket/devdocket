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

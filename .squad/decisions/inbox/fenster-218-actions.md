# Decision: Editor State Transitions Use Duplicated Transition Map

**Author:** Fenster (Extension Dev)
**Date:** 2026-04-14
**Issue:** #218

## Context

The work item state machine (`VALID_TRANSITIONS`) lives in `workGraph.ts`. The editor panel HTML needs to know which transitions are valid to render buttons. The HTML module (`editorPanelHtml.ts`) is a pure function that generates a string — it doesn't have access to `WorkGraph`.

## Decision

Duplicated the transition-to-button mapping as `getTransitionActions()` in `editorPanelHtml.ts` rather than importing or sharing the `VALID_TRANSITIONS` map. The function returns labeled, styled button definitions per state.

## Rationale

- `editorPanelHtml.ts` is a pure HTML generator with no service dependencies — importing `WorkGraph` would break that boundary
- The button labels (Start, Resume, Complete, etc.) and primary/secondary styling are UI concerns that don't belong in the state machine
- The state machine rarely changes; if it does, the HTML tests will catch mismatches since they assert specific buttons per state
- Exporting `getTransitionActions()` makes it independently testable

## Risk

If new states or transitions are added to `VALID_TRANSITIONS` but not mirrored in `getTransitionActions()`, the editor will be missing buttons. Mitigated by the test suite which covers all states.

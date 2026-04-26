---
applyTo: "packages/ai-reviewer/**"
---

# AI Reviewer Conventions

## BasePrAction Pattern

Shared PR action logic (diff fetching, GitHub auth, LLM model selection, prompt loading with custom file support, workspace path validation) lives in `BasePrAction` (`basePrAction.ts`). New PR-based actions should extend this base class — subclasses need ~25 lines instead of ~240.

`AiReviewAction` extends `BasePrAction` and provides configuration properties plus `getRuntimeInstructions()`. `AiWalkthroughAction` is a standalone `DevDocketAction` (not a subclass) that prepares a worktree and opens the `@walkthrough` chat participant.

## Prompt Injection Prevention

- Sanitize URLs via `new URL(url)` + strip control characters before LLM prompt interpolation
- Validate `baseRef` with strict regex allowlist `/^[a-zA-Z0-9._\/-]+$/` before interpolation into LLM prompts
- Custom prompt file paths must be validated as contained within the workspace folder via `path.normalize()` + prefix comparison

## Chat Participant Pattern

The `@walkthrough` chat participant uses a tool-use loop with 6 LM tools for repo access. The participant is registered in `extension.ts` alongside the actions.

## CancellationTokenLike

When types in `@devdocket/shared` need to reference `vscode.CancellationToken` without a vscode dependency, use the minimal `CancellationTokenLike` interface. Callers pass the full vscode type which satisfies it structurally.

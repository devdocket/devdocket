---
applyTo: "packages/start-git-work/**"
---

# Start Git Work Conventions

## Git Operation Safety

- Always check preconditions before destructive git operations: branch existence with `git show-ref --verify`, directory existence with `fs.existsSync`
- Implement rollback for multi-step operations (e.g., delete branch if worktree creation fails)
- Use `git branch -d` (not `-D`) to warn about unmerged changes
- Use `--` terminators on all git commands to prevent path/flag ambiguity

## Git Authentication

Pass credentials via environment variables, not CLI args:

```typescript
// ✅ Safe — credentials in env vars, not visible in process list
env: {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
}

// ❌ Unsafe — credentials visible in process list
// -c http.extraheader="AUTHORIZATION: bearer ${token}"
```

## Activity Log Integration

When creating branches/worktrees, log via `devdocket.addActivity` with type `'work-started'` and a JSON detail string built with the **`encodeWorkStartedDetail` helper** from `./workStartedDetail`. Never call `JSON.stringify` directly on an ad-hoc shape — the helper stamps a version tag so future readers (e.g. `gitCleanup.ts`) can detect schema mismatches instead of silently degrading.

```ts
import { encodeWorkStartedDetail } from './workStartedDetail';

const detail = encodeWorkStartedDetail({ branchName, worktreePath, repoPath });
await vscode.commands.executeCommand('devdocket.addActivity', item.id, 'work-started', detail);
```

To read the detail elsewhere, use `decodeWorkStartedDetail` from the same module. It handles current `v: 1` payloads, accepts legacy unversioned entries for backward compatibility, and warns (returning `undefined`) for unknown schema versions.

Cleanup operations log `'cleanup'` or `'cleanup-dismissed'` entries. The activity log is the source of truth for branch/worktree associations — do not add metadata fields to WorkItem.

**Bumping the schema:** if the payload shape needs to change, introduce a new `WorkStartedDetailV2` interface, update the encoder to write `v: 2`, and update the decoder to recognise both versions. The editor's `packages/core/src/webview/editor/components/ActivityLog.tsx` also reads these entries to render them — its `KNOWN_WORK_STARTED_DETAIL_VERSION` and field set must be updated in the same change. Renaming or removing existing fields without a version bump silently breaks cleanup for every pre-existing activity entry.

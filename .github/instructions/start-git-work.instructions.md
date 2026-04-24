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

When creating branches/worktrees, log via `devdocket.addActivity` with type `'work-started'` and a JSON detail string containing `{ branchName, worktreePath, repoPath }`. Cleanup operations log `'cleanup'` or `'cleanup-dismissed'` entries. The activity log is the source of truth for branch/worktree associations — do not add metadata fields to WorkItem.

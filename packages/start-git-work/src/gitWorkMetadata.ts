/** Persisted metadata about a branch/worktree created by StartWorkAction. */
export interface GitWorkMetadata {
  branchName: string;
  worktreePath: string;
  repoPath: string;
}

/** Returns the globalState key used to store git work metadata for a work item. */
export function metadataKey(itemId: string): string {
  return `gitWork:${itemId}`;
}

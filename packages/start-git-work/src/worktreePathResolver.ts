import * as fs from 'fs';
import * as path from 'path';
import type { WorkItem } from '@devdocket/shared';

export interface WorktreePathGitWork {
  kind: 'issue' | 'pr';
  cloneUrl: string;
  repoLabel?: string;
}

export function getDefaultWorktreePath(
  repoPath: string,
  ref: string,
  item: Readonly<WorkItem>,
  gitWork: WorktreePathGitWork,
): string {
  return path.join(path.dirname(repoPath), toWorktreeDirName(repoPath, ref, item, gitWork));
}

export function toWorktreeDirName(
  repoPath: string,
  ref: string,
  item: Readonly<WorkItem>,
  gitWork: WorktreePathGitWork,
): string {
  const itemNumber = workItemNumber(item.externalId ?? item.id);
  if (itemNumber) {
    const repoBaseName = sourceRepoBaseName(gitWork, repoPath);
    return `${repoBaseName}-${gitWork.kind}-${itemNumber}`;
  }

  const repoBaseName = path.basename(repoPath);
  const refSuffix = toWorktreePathSuffix(ref);
  const identitySuffix = worktreeFallbackIdentity(item);
  return identitySuffix ? `${repoBaseName}-${refSuffix}-${identitySuffix}` : `${repoBaseName}-${refSuffix}`;
}

export function validateWorktreePath(input: string, repoPath: string): string | undefined {
  const trimmedInput = input.trim();
  if (trimmedInput.length === 0) {
    return 'Worktree path is required.';
  }
  if (!path.isAbsolute(trimmedInput)) {
    return 'Worktree path must be absolute.';
  }

  const resolvedPath = path.resolve(trimmedInput);
  const parentPath = path.dirname(resolvedPath);
  if (!fs.existsSync(parentPath)) {
    return `Parent directory "${parentPath}" does not exist.`;
  }
  if (fs.existsSync(resolvedPath)) {
    return `Worktree path "${resolvedPath}" already exists.`;
  }
  if (isPathInsideOrEqual(parentPath, repoPath)) {
    return 'Worktree parent directory must not be inside the source repository.';
  }

  return undefined;
}

export function isPathInsideOrEqual(candidatePath: string, containerPath: string): boolean {
  const relative = path.relative(path.resolve(containerPath), path.resolve(candidatePath));
  return relative === '' || (relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function worktreeFallbackIdentity(item: Readonly<WorkItem>): string | undefined {
  const identity = [item.providerId, item.externalId ?? item.id].filter(Boolean).join(':');
  return identity ? shortStableHash(identity) : undefined;
}

export function shortStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, '0').slice(0, 6);
}

export function workItemNumber(externalId: string | undefined): string | undefined {
  return externalId?.trim().match(/(?:#|!)(\d+)$/)?.[1]
    ?? externalId?.trim().match(/(?:^|[\/\\_-])(\d+)$/)?.[1];
}

export function sourceRepoBaseName(gitWork: WorktreePathGitWork, repoPath: string): string {
  const candidate = repoBaseNameFromLabel(gitWork.repoLabel)
    ?? repoBaseNameFromCloneUrl(gitWork.cloneUrl)
    ?? path.basename(repoPath);
  return toWorktreePathSuffix(candidate);
}

export function repoBaseNameFromLabel(repoLabel: string | undefined): string | undefined {
  return repoLabel?.split(/[\\/]/).filter(Boolean).at(-1);
}

export function repoBaseNameFromCloneUrl(cloneUrl: string): string | undefined {
  try {
    return new URL(cloneUrl).pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '');
  } catch {
    return cloneUrl.match(/^git@[^:]+:(.+)$/)?.[1].split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '');
  }
}

export function toWorktreePathSuffix(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
}

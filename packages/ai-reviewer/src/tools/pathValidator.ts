import * as path from 'path';
import { validWorktreePaths } from './worktreeRegistry';

/**
 * Validates that a worktree path is a known managed worktree.
 * Returns undefined if valid, or an error message string if invalid.
 */
export function validateWorktreePath(worktreePath: string): string | undefined {
  if (!validWorktreePaths.has(path.resolve(worktreePath))) {
    return 'Invalid worktree path: not a known managed worktree';
  }
  return undefined;
}

/**
 * Validates a relative path against path traversal attacks.
 * Ensures the path:
 * - Is not absolute
 * - Does not escape the worktree via ".." segments
 * - Resolves to a location within the worktree root
 *
 * @param worktreePath The worktree root path (must already be validated via validateWorktreePath)
 * @param relativePath The relative path to validate (file or directory)
 * @returns undefined if valid, or an error message string if invalid
 */
export function validateRelativePath(worktreePath: string, relativePath: string): string | undefined {
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) {
    return 'Path traversal not allowed: path must be relative and within the worktree';
  }
  const resolved = path.resolve(worktreePath, normalized);
  const root = path.resolve(worktreePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return 'Path traversal not allowed: resolved path escapes the worktree';
  }
  return undefined;
}

/**
 * Validates both worktree path and relative path.
 * Combines validateWorktreePath and validateRelativePath for convenience.
 *
 * @param worktreePath The worktree root path
 * @param relativePath The relative path to validate (file or directory)
 * @returns undefined if valid, or an error message string if invalid
 */
export function validatePath(worktreePath: string, relativePath: string): string | undefined {
  const wtError = validateWorktreePath(worktreePath);
  if (wtError) return wtError;

  return validateRelativePath(worktreePath, relativePath);
}

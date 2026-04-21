import * as path from 'path';
import { validWorktreePaths } from './worktreeRegistry';

/**
 * Checks if a candidate path is at or within a root directory.
 * Uses path.relative to handle edge cases like filesystem roots.
 *
 * @param root The root directory path
 * @param candidate The candidate path to check
 * @returns true if candidate is equal to or within root, false otherwise
 */
export function isAtOrWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

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
 * Validates a relative file path against path traversal attacks.
 * Ensures the path:
 * - Is not absolute
 * - Does not escape the worktree via ".." segments
 * - Resolves to a location within the worktree root
 *
 * @param worktreePath The worktree root path (must already be validated via validateWorktreePath)
 * @param filePath The relative file path to validate
 * @param paramName Optional parameter name for error messages (defaults to 'filePath')
 * @returns undefined if valid, or an error message string if invalid
 */
export function validateRelativePath(
  worktreePath: string,
  filePath: string,
  paramName = 'filePath',
): string | undefined {
  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) {
    return `Path traversal not allowed: ${paramName} must be relative and within the worktree`;
  }
  const resolved = path.resolve(worktreePath, normalized);
  const root = path.resolve(worktreePath);
  // Use isAtOrWithinRoot helper to check containment - handles filesystem root edge case
  if (!isAtOrWithinRoot(root, resolved)) {
    return 'Path traversal not allowed: resolved path escapes the worktree';
  }
  return undefined;
}

/**
 * Validates both worktree path and relative file path.
 * Combines validateWorktreePath and validateRelativePath for convenience.
 *
 * @param worktreePath The worktree root path
 * @param filePath The relative file path to validate
 * @returns undefined if valid, or an error message string if invalid
 */
export function validatePath(worktreePath: string, filePath: string): string | undefined {
  const wtError = validateWorktreePath(worktreePath);
  if (wtError) return wtError;

  return validateRelativePath(worktreePath, filePath);
}

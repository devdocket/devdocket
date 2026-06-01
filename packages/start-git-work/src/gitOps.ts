import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { logger } from './logger';

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

function commandOptions(cwd: string, timeout: number, signal?: AbortSignal): { cwd: string; timeout: number; signal?: AbortSignal } {
  return signal === undefined ? { cwd, timeout } : { cwd, timeout, signal };
}

/** Timeout for lightweight git metadata commands (branch --list, status, rev-parse). */
export const GIT_METADATA_TIMEOUT = 30_000;
/** Timeout for heavy git operations that touch the working tree (worktree add, checkout, fetch). */
export const GIT_CHECKOUT_TIMEOUT = 300_000;

/** Strict allowlist for git ref names — blocks argument injection via leading hyphens. */
const SAFE_REF = /^[a-zA-Z0-9._\/-]+$/;

export interface PrBranchInfo {
  branchName: string;
  sourceRef: string;
  /** Remote tracking ref when branch is on a non-origin remote (e.g. "devdocket-fork-contributor/fix-bug"). */
  trackingRef?: string;
}

export interface GitWorkForPrFetch {
  cloneUrl: string;
  headCloneUrl?: string;
  ref: string;
  repoLabel?: string;
}

export class GitFetchBranchError extends Error {
  constructor(
    readonly upstreamBranchName: string,
    readonly remoteName: string,
    readonly details: string,
  ) {
    super(`Could not fetch branch '${upstreamBranchName}' from remote '${remoteName}'. ${details}`);
  }
}

export function isValidRef(ref: unknown): ref is string {
  if (typeof ref !== 'string'
    || ref.length === 0
    || ref.startsWith('-')
    || !SAFE_REF.test(ref)
    || ref.endsWith('/')
    || ref.endsWith('.')
    || ref.includes('//')
    || ref.includes('..')
    || ref.includes('@{')
    || ref === '@') {
    return false;
  }

  return ref.split('/').every(segment => segment.length > 0
    && !segment.startsWith('.')
    && !segment.endsWith('.lock'));
}

/** Rejects whitespace and control characters in clone URLs. */
const UNSAFE_URL_CHARS = /[\s\x00-\x1f\x7f]/;

export function normalizeCloneUrl(url: string): string {
  if (!url.startsWith('https://')) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'dev.azure.com' || !parsed.username) {
      return url;
    }
    parsed.username = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isValidCloneUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || UNSAFE_URL_CHARS.test(url)) {
    return false;
  }
  if (url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:'
        && parsed.hostname.length > 0
        && (!parsed.username || parsed.hostname.toLowerCase() === 'dev.azure.com')
        && !parsed.password
        && !parsed.search
        && !parsed.hash;
    } catch {
      return false;
    }
  }
  return isValidGitSshCloneUrl(url);
}

function isValidGitSshCloneUrl(url: string): boolean {
  const match = url.match(/^git@([^:]+):(.+)$/);
  if (!match) {
    return false;
  }
  const [, host, repoPath] = match;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && repoPath.length > 0;
}

export function normalizeBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function isAbortError(err: unknown): boolean {
  const abortError = err as { name?: string; code?: string };
  return abortError?.name === 'AbortError' || abortError?.code === 'ABORT_ERR';
}

export function formatGitError(error: unknown): string {
  const gitError = error as { stderr?: string; stdout?: string; message?: string };
  const detail = [gitError.stderr, gitError.stdout, gitError.message]
    .map(value => value?.trim())
    .find(Boolean);
  return detail ?? 'Check your network connection, permissions, and whether the branch still exists.';
}

export async function runGit(
  repoPath: string,
  args: readonly string[],
  timeout: number = GIT_METADATA_TIMEOUT,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, commandOptions(repoPath, timeout, signal));
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, commandOptions(cwd, timeout, signal));
}

export async function listBranches(repoPath: string, branchName: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runGit(repoPath, ['branch', '--list', branchName], GIT_METADATA_TIMEOUT, signal);
  return stdout;
}

export async function createBranch(repoPath: string, branchName: string, baseBranch: string, signal?: AbortSignal): Promise<void> {
  await runGit(repoPath, ['branch', branchName, baseBranch], GIT_METADATA_TIMEOUT, signal);
}

export async function addWorktree(repoPath: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  await runGit(repoPath, ['worktree', 'add', ...args], GIT_CHECKOUT_TIMEOUT, signal);
}

export async function checkout(repoPath: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  await runGit(repoPath, ['checkout', ...args], GIT_CHECKOUT_TIMEOUT, signal);
}

export async function getStatusPorcelain(repoPath: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runGit(repoPath, ['status', '--porcelain'], GIT_METADATA_TIMEOUT, signal);
  return stdout;
}

export async function localBranchExists(branchName: string, repoPath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', '--', `refs/heads/${branchName}`], GIT_METADATA_TIMEOUT, signal);
    return true;
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    return false;
  }
}

export async function fetchPrBranch(
  gitWork: GitWorkForPrFetch,
  repoPath: string,
  localBranchName?: string,
  signal?: AbortSignal,
): Promise<PrBranchInfo> {
  const upstreamBranchName = normalizeBranchName(gitWork.ref);
  const branchName = localBranchName ?? upstreamBranchName;
  const cloneUrl = gitWork.headCloneUrl ?? gitWork.cloneUrl;

  logger.info(`Fetching provider-supplied PR branch "${upstreamBranchName}"`);
  const remoteName = await findOrAddRemote(cloneUrl, gitWork.repoLabel, repoPath, signal);
  const sourceRef = `${remoteName}/${upstreamBranchName}`;

  try {
    await runGit(repoPath, [
      'fetch',
      remoteName,
      `+refs/heads/${upstreamBranchName}:refs/remotes/${remoteName}/${upstreamBranchName}`,
    ], GIT_CHECKOUT_TIMEOUT, signal);
    logger.debug(`Fetch complete for branch "${upstreamBranchName}" from remote "${remoteName}"`);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    const details = formatGitError(err);
    logger.info(`Failed to fetch branch "${upstreamBranchName}" from ${remoteName}: ${details}`);
    throw new GitFetchBranchError(upstreamBranchName, remoteName, details);
  }

  if (remoteName === 'origin') {
    return { branchName, sourceRef };
  }
  return { branchName, sourceRef, trackingRef: sourceRef };
}

/**
 * Finds a local remote whose fetch URL matches cloneUrl, or adds a
 * new DevDocket-managed remote pointing to it.
 */
export async function findOrAddRemote(cloneUrl: string, repoLabel: string | undefined, repoPath: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runGit(repoPath, ['remote', '-v'], GIT_METADATA_TIMEOUT, signal);
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
    if (match && match[2] === cloneUrl) {
      const name = match[1];
      if (!isValidRef(name)) {
        logger.warn(`Skipping remote "${name}" — name contains unsafe characters`);
        continue;
      }
      logger.info(`Found existing remote "${name}" matching ${cloneUrl}`);
      return name;
    }
  }

  const remoteName = toRemoteName(cloneUrl, repoLabel);
  logger.debug(`No remote found for ${cloneUrl}, adding "${remoteName}"`);

  try {
    await runGit(repoPath, ['remote', 'add', remoteName, cloneUrl], GIT_METADATA_TIMEOUT, signal);
    logger.info(`Added remote "${remoteName}" → ${cloneUrl}`);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    try {
      const { stdout: existingUrl } = await runGit(repoPath, ['remote', 'get-url', remoteName], GIT_METADATA_TIMEOUT, signal);
      if (existingUrl.trim() !== cloneUrl) {
        logger.info(`Remote "${remoteName}" exists with different URL, updating to "${cloneUrl}".`);
        await runGit(repoPath, ['remote', 'set-url', remoteName, cloneUrl], GIT_METADATA_TIMEOUT, signal);
      } else {
        logger.debug(`Remote "${remoteName}" already exists with correct URL`);
      }
    } catch {
      throw err;
    }
  }

  return remoteName;
}

/**
 * Returns the path of a worktree that has branchName checked out as its branch ref.
 */
export async function findWorktreeHoldingBranch(
  branchName: string,
  repoPath: string,
  excludeWorktreePath?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(repoPath, ['worktree', 'list', '--porcelain'], GIT_METADATA_TIMEOUT, signal));
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    // Pre-check is best-effort — if it fails, fall through and let the actual
    // git operation surface any real error.
    logger.debug(`git worktree list --porcelain failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const targetRef = `refs/heads/${branchName}`;
  const normalizedExclude = excludeWorktreePath ? path.resolve(excludeWorktreePath) : undefined;
  let currentWorktree: string | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      currentWorktree = line.slice('worktree '.length);
    } else if (line === '') {
      currentWorktree = undefined;
    } else if (line === `branch ${targetRef}` && currentWorktree !== undefined) {
      if (normalizedExclude !== undefined && pathsEqual(currentWorktree, normalizedExclude)) {
        continue;
      }
      return currentWorktree;
    }
  }
  return undefined;
}

/**
 * Compares two filesystem paths for equality after normalisation. Uses
 * case-insensitive comparison on Windows; case-sensitive elsewhere.
 */
export function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

export async function rollbackCreatedBranch(branchName: string, baseBranch: string, repoPath: string): Promise<void> {
  try {
    await runGit(repoPath, ['branch', '-d', '--', branchName], GIT_METADATA_TIMEOUT);
    return;
  } catch (deleteErr) {
    const branchRef = `refs/heads/${branchName}`;
    const [{ stdout: branchHead }, { stdout: baseHead }] = await Promise.all([
      runGit(repoPath, ['rev-parse', '--verify', '--', branchRef], GIT_METADATA_TIMEOUT),
      runGit(repoPath, ['rev-parse', '--verify', '--', baseBranch], GIT_METADATA_TIMEOUT),
    ]);
    if (branchHead.trim() === baseHead.trim()) {
      await runGit(repoPath, ['branch', '-D', '--', branchName], GIT_METADATA_TIMEOUT);
      return;
    }
    throw deleteErr;
  }
}

export function toRemoteName(cloneUrl: string, repoLabel?: string): string {
  const candidate = ownerLikeSegmentFromCloneUrl(cloneUrl) ?? repoLabel ?? cloneUrl;
  const suffix = candidate.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
  const remoteName = `devdocket-fork-${suffix}`;
  return isValidRef(remoteName) ? remoteName : 'devdocket-fork-source';
}

function ownerLikeSegmentFromCloneUrl(cloneUrl: string): string | undefined {
  if (cloneUrl.startsWith('https://')) {
    try {
      const segments = new URL(cloneUrl).pathname.split('/').filter(Boolean);
      if (segments.some(segment => segment.toLowerCase() === '_git')) {
        return undefined;
      }
      return segments.length >= 2 ? segments[segments.length - 2] : undefined;
    } catch {
      return undefined;
    }
  }

  const gitPath = cloneUrl.match(/^git@[^:]+:(.+)$/)?.[1];
  if (!gitPath) {
    return undefined;
  }
  const segments = gitPath.split('/').filter(Boolean);
  return segments.length >= 2 ? segments[segments.length - 2] : undefined;
}

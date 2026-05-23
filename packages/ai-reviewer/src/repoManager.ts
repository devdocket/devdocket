import * as vscode from 'vscode';
import { combineSignals, createAbortError } from '@devdocket/shared';
import * as path from 'path';
import * as fs from 'fs/promises';
import { parseAdoPrUrl, parsePrUrl } from './prUrl';
import { AdoPrClient } from './adoPrClient';
import { getAdoSession, getGitHubSession } from './auth';
import { GitExecError, gitExec } from './tools/gitUtils';
import { validWorktreePaths } from './tools/worktreeRegistry';
import { isValidRef } from './tools/refValidation';

export { parsePrUrl };

/** Minimum git version required for GIT_CONFIG_COUNT env-based config injection. */
const MIN_GIT_VERSION = [2, 31] as const;
const UNSAFE_URL_CHARS = /[\s\x00-\x1f\x7f]/;

let gitVersionChecked = false;

/** Verify git >= 2.31 (needed for GIT_CONFIG_COUNT env vars). Runs once. */
async function ensureGitVersion(signal?: AbortSignal): Promise<void> {
  if (gitVersionChecked) return;
  const raw = await gitExec(['version'], '.', { signal });
  const match = raw.match(/(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `Could not determine git version from: ${raw.trim()}. DevDocket AI Reviewer requires git >= ${MIN_GIT_VERSION[0]}.${MIN_GIT_VERSION[1]}.`,
    );
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  if (major < MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor < MIN_GIT_VERSION[1])) {
    throw new Error(
      `git ${major}.${minor} is too old. DevDocket AI Reviewer requires git >= ${MIN_GIT_VERSION[0]}.${MIN_GIT_VERSION[1]} for secure credential handling. Please upgrade git.`,
    );
  }
  gitVersionChecked = true;
}

function resetGitVersionCheck(): void {
  gitVersionChecked = false;
}

/** @internal Test-only hooks for repoManager.ts. */
export const __testing = {
  resetGitVersionCheck,
  repoDirFor,
};

export interface WorktreeInfo {
  worktreePath: string;
  clonePath: string;
  org: string;
  repo: string;
  prNumber: string;
  headRef: string;
  baseRef: string;
  prUrl?: string;
  provider?: 'github' | 'ado';
}

/**
 * Run a git command with transient auth injected via environment variables.
 * Uses GIT_CONFIG_COUNT/KEY/VALUE (git ≥ 2.31) so the token never appears
 * in process argument lists visible to other users.
 */
async function gitAuth(
  args: string[],
  cwd: string,
  token: string,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return gitWithExtraHeader(args, cwd, `Authorization: Basic ${encoded}`, timeout, signal);
}

async function gitWithExtraHeader(
  args: string[],
  cwd: string,
  extraHeader: string,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  await ensureGitVersion(signal);
  return gitExec(args, cwd, {
    timeout,
    signal,
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: extraHeader,
    },
  });
}

async function gitAdoAuth(
  args: string[],
  cwd: string,
  token: string,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  return gitWithExtraHeader(args, cwd, `Authorization: Bearer ${token}`, timeout, signal);
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

type RepoDirInput =
  | { provider: 'github'; org: string; repo: string }
  | { provider: 'ado'; org: string; project: string; repo: string };

function repoDirFor(input: RepoDirInput): string {
  if (input.provider === 'github') {
    return `${sanitizePathSegment(input.org)}-${sanitizePathSegment(input.repo)}`;
  }

  return sanitizePathSegment(`ado-${input.org}-${input.project}-${input.repo}`);
}

function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.href.replace(/[\x00-\x1f\x7f`]/g, '');
  } catch {
    return '(URL unavailable)';
  }
}

function isValidCloneUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || UNSAFE_URL_CHARS.test(url)) {
    return false;
  }
  if (url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

function cloneArgs(args: string[]): string[] {
  return process.platform === 'win32'
    ? ['-c', 'core.longpaths=true', ...args]
    : args;
}

type RepoAbortError = Error & { step?: string };

function isAbortError(err: unknown): err is RepoAbortError {
  return err instanceof Error && err.name === 'AbortError';
}

function createStepAbortError(step: string): RepoAbortError {
  const error = createAbortError() as RepoAbortError;
  error.message = `Cancelled during ${step}`;
  error.step = step;
  return error;
}

function abortFromToken(token?: vscode.CancellationToken): { signal: AbortSignal | undefined; dispose(): void } {
  if (!token) {
    return { signal: undefined, dispose() {} };
  }

  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort(createAbortError());
  }

  const subscription = token.onCancellationRequested(() => controller.abort(createAbortError()));
  return {
    signal: controller.signal,
    dispose() {
      subscription.dispose();
    },
  };
}

function underlyingErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pathContextError(operation: string, label: string, targetPath: string, err: unknown): Error {
  const message = `${operation} (${label}: ${targetPath}): ${underlyingErrorMessage(err)}`;
  if (err instanceof GitExecError) {
    const wrapped = new GitExecError(message, err.exitCode);
    (wrapped as Error & { cause?: unknown }).cause = err;
    return wrapped;
  }
  const wrapped = new Error(message);
  (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}

async function withPathContext<T>(operation: string, label: string, targetPath: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw pathContextError(operation, label, targetPath, err);
  }
}

async function configureLongPaths(clonePath: string, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'win32') {
    await withPathContext(
      'Failed to configure Git long path support',
      'repo',
      clonePath,
      gitExec(['config', '--local', 'core.longpaths', 'true'], clonePath, { signal }),
    );
  }
}

async function deleteDirectoryNoTrash(dirPath: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(dirPath), { recursive: true, useTrash: false });
  } catch (err) {
    if (process.platform !== 'win32') {
      throw err;
    }
    await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function isInvalidGitDirectoryError(err: unknown): boolean {
  // `rev-parse` reports many repository-shape failures as exit 128, and the
  // stderr text may be localized. Prefer recovery over leaving a partial dir wedged.
  return err instanceof GitExecError && err.exitCode === 128;
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export class RepoManager {
  private worktrees = new Map<string, WorktreeInfo>();

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Clone repo if needed, create worktree if needed, fetch + checkout PR branch. */
  async ensureWorktree(prUrl: string, token?: vscode.CancellationToken): Promise<WorktreeInfo> {
    const logPrUrl = sanitizeUrlForLog(prUrl);
    this.log.debug(`ensureWorktree called — prUrl: ${logPrUrl}`);
    const github = parsePrUrl(prUrl);
    if (github) {
      return this.ensureGitHubWorktree(prUrl, github.org, github.repo, github.prNumber, token);
    }

    const ado = parseAdoPrUrl(prUrl);
    if (ado) {
      return this.ensureAdoWorktree(prUrl, ado.org, ado.project, ado.repo, ado.prId, token);
    }

    this.log.error(`Invalid PR URL: ${logPrUrl}`);
    throw new Error(`Invalid PR URL: ${logPrUrl}`);
  }

  private async ensureGitHubWorktree(
    prUrl: string,
    org: string,
    repo: string,
    prNumber: string,
    token?: vscode.CancellationToken,
  ): Promise<WorktreeInfo> {
    const key = this.githubKey(org, repo, prNumber);
    this.log.info(`Parsed GitHub PR: org=${org}, repo=${repo}, prNumber=${prNumber}`);

    const repoDir = repoDirFor({ provider: 'github', org, repo });
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const clonePath = path.join(repoBase, 'clone');
    const worktreePath = path.join(repoBase, 'worktrees', `pr-${prNumber}`);
    this.log.debug(`Paths — clonePath: ${clonePath}, worktreePath: ${worktreePath}`);

    const cancellation = abortFromToken(token);
    try {
      this.log.info('Requesting GitHub auth session');
      this.throwIfCancelled(token, cancellation.signal, 'GitHub authentication');
      const session = await this.runStep('GitHub authentication', () =>
        getGitHubSession({ interactive: true, signal: cancellation.signal }),
      );
      if (!session) {
        this.log.error('GitHub authentication not available');
        throw new Error('GitHub authentication required');
      }
      this.log.debug(`GitHub auth obtained — account: ${session.account?.label ?? 'unknown'}`);
      this.throwIfCancelled(token, cancellation.signal, 'GitHub authentication');

      const cloneUrl = `https://github.com/${org}/${repo}.git`;
      const cloneExists = await this.ensureValidGitDirectory(clonePath, 'repository', undefined, cancellation.signal);
      this.log.debug(`Clone directory exists and is valid: ${cloneExists}`);
      if (!cloneExists) {
        this.log.info('Cloning repository');
        this.log.debug(`Clone destination: ${clonePath}`);
        const cloneParent = path.dirname(clonePath);
        await withPathContext(
          'Failed to create repository directory',
          'directory',
          cloneParent,
          vscode.workspace.fs.createDirectory(vscode.Uri.file(cloneParent)),
        );
        await this.runStep('clone repository', () =>
          withPathContext(
            'Failed to clone repository',
            'repo',
            clonePath,
            gitAuth(
              cloneArgs(['clone', '--no-checkout', cloneUrl, clonePath]),
              cloneParent,
              session.accessToken,
              300_000,
              cancellation.signal,
            ),
          ),
        );
        this.log.info('Clone complete');
      }
      this.throwIfCancelled(token, cancellation.signal, 'configure Git long path support');
      await this.runStep('configure Git long path support', () => configureLongPaths(clonePath, cancellation.signal));

      this.throwIfCancelled(token, cancellation.signal, 'fetch PR metadata');
      this.log.info('Fetching PR metadata from GitHub API');
      const prMeta = await this.runStep('fetch PR metadata', () =>
        this.fetchPrMetadata(org, repo, prNumber, session.accessToken, cancellation.signal),
      );
      const baseRef = prMeta.baseRef;
      const headRef = `pr-${prNumber}`;
      const diffHeadRef = 'HEAD';

      if (!isValidRef(baseRef)) {
        const safeBaseRef = JSON.stringify(baseRef);
        this.log.error(`Invalid base ref from GitHub API: ${safeBaseRef}`);
        throw new Error(`Invalid base ref from GitHub API: ${safeBaseRef}`);
      }
      this.log.info(`PR metadata — baseRef: ${baseRef}, headSha: ${prMeta.headSha}, local headRef: ${headRef}`);
      this.throwIfCancelled(token, cancellation.signal, 'validate worktree');

      const worktreeExists = await this.ensureValidGitDirectory(worktreePath, 'worktree', clonePath, cancellation.signal);
      this.log.debug(`Worktree directory exists and is valid: ${worktreeExists}`);
      if (worktreeExists) {
        this.log.info('Updating existing worktree — fetching PR head');
        await this.runStep('fetch PR head', () =>
          withPathContext(
            'Failed to fetch PR head',
            'worktree',
            worktreePath,
            gitAuth(
              ['fetch', 'origin', `pull/${prNumber}/head`],
              worktreePath,
              session.accessToken,
              300_000,
              cancellation.signal,
            ),
          ),
        );
        await this.runStep('reset worktree', () =>
          withPathContext(
            'Failed to reset worktree',
            'worktree',
            worktreePath,
            gitExec(['reset', '--hard', 'FETCH_HEAD'], worktreePath, { signal: cancellation.signal }),
          ),
        );
        this.log.info('Worktree updated');
      } else {
        this.log.info('Creating new worktree — fetching PR head');
        await this.runStep('fetch PR head', () =>
          withPathContext(
            'Failed to fetch PR head',
            'repo',
            clonePath,
            gitAuth(
              ['fetch', 'origin', `pull/${prNumber}/head:${headRef}`],
              clonePath,
              session.accessToken,
              300_000,
              cancellation.signal,
            ),
          ),
        );
        this.log.info('PR head fetched');
      }

      this.throwIfCancelled(token, cancellation.signal, 'fetch base branch');
      this.log.info(`Fetching base branch: ${baseRef}`);
      await this.runStep('fetch base branch', () =>
        withPathContext(
          'Failed to fetch base branch',
          'repo',
          clonePath,
          gitAuth(
            ['fetch', 'origin', `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
            clonePath,
            session.accessToken,
            300_000,
            cancellation.signal,
          ),
        ),
      );
      this.log.info('Base branch fetched');
      this.throwIfCancelled(token, cancellation.signal, 'fetch base branch');

      if (!worktreeExists) {
        if (cloneExists) {
          await this.runStep('prune worktree metadata', () => this.pruneWorktreeMetadata(clonePath, undefined, cancellation.signal));
        }
        this.log.info('Creating worktree');
        this.log.debug(`Worktree destination: ${worktreePath}, ref: ${headRef}`);
        await this.runStep('create worktree', () =>
          withPathContext(
            'Failed to create worktree',
            'worktree',
            worktreePath,
            gitExec(['worktree', 'add', worktreePath, headRef], clonePath, { signal: cancellation.signal }),
          ),
        );
        this.log.info('Worktree created');
      }

      const info: WorktreeInfo = {
        worktreePath,
        clonePath,
        org,
        repo,
        prNumber,
        headRef: diffHeadRef,
        baseRef: `origin/${baseRef}`,
        prUrl,
        provider: 'github',
      };

      this.worktrees.set(key, info);
      validWorktreePaths.add(path.resolve(worktreePath));
      this.log.debug(`ensureWorktree complete — worktree ready at ${worktreePath}`);
      return info;
    } finally {
      cancellation.dispose();
    }
  }

  private async ensureAdoWorktree(
    prUrl: string,
    org: string,
    project: string,
    repo: string,
    prNumber: string,
    token?: vscode.CancellationToken,
  ): Promise<WorktreeInfo> {
    const key = this.adoKey(org, project, repo, prNumber);
    this.log.info(`Parsed ADO PR: org=${org}, project=${project}, repo=${repo}, prNumber=${prNumber}`);

    const repoDir = repoDirFor({ provider: 'ado', org, project, repo });
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const clonePath = path.join(repoBase, 'clone');
    const worktreePath = path.join(repoBase, 'worktrees', `pr-${prNumber}`);
    this.log.debug(`ADO paths — clonePath: ${clonePath}, worktreePath: ${worktreePath}`);

    const cancellation = abortFromToken(token);
    try {
      this.throwIfCancelled(token, cancellation.signal, 'Azure DevOps authentication');

      const session = await this.runStep('Azure DevOps authentication', () =>
        getAdoSession({ interactive: true, signal: cancellation.signal }),
      );
      if (!session) {
        this.log.error('Microsoft authentication not available');
        throw new Error('Azure DevOps authentication required');
      }
      this.throwIfCancelled(token, cancellation.signal, 'Azure DevOps authentication');

      const details = await this.runStep('fetch PR metadata', () =>
        new AdoPrClient(fetch, async () => session).fetchPullRequestDetails(
          { org, project, repo, prId: prNumber },
          { interactive: true, signal: cancellation.signal },
        ),
      );
      if (!details) {
        throw new Error('Azure DevOps authentication required');
      }
      this.throwIfCancelled(token, cancellation.signal, 'fetch PR metadata');

      const sourceRef = details.sourceRefName;
      const targetRef = details.targetRefName;
      if (!sourceRef || !targetRef || !isValidRef(sourceRef) || !isValidRef(targetRef)) {
        throw new Error('Azure DevOps PR metadata contained missing or invalid source or target refs');
      }

      const cloneUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
      if (!isValidCloneUrl(cloneUrl)) {
        throw new Error('Azure DevOps repository clone URL is invalid');
      }

      const cloneExists = await this.ensureValidGitDirectory(clonePath, 'repository', undefined, cancellation.signal);
      if (!cloneExists) {
        this.log.info('Cloning Azure Repos repository');
        const cloneParent = path.dirname(clonePath);
        await withPathContext(
          'Failed to create repository directory',
          'directory',
          cloneParent,
          vscode.workspace.fs.createDirectory(vscode.Uri.file(cloneParent)),
        );
        await this.runStep('clone repository', () =>
          withPathContext(
            'Failed to clone Azure Repos repository',
            'repo',
            clonePath,
            gitAdoAuth(
              cloneArgs(['clone', '--no-checkout', cloneUrl, clonePath]),
              cloneParent,
              session.accessToken,
              300_000,
              cancellation.signal,
            ),
          ),
        );
        this.log.info('ADO clone complete');
      }
      this.throwIfCancelled(token, cancellation.signal, 'configure Git long path support');
      await this.runStep('configure Git long path support', () => configureLongPaths(clonePath, cancellation.signal));

      this.throwIfCancelled(token, cancellation.signal, 'fetch ADO refs');
      const headRef = `refs/devdocket/ado/pr-${prNumber}-head`;
      const baseRef = `refs/devdocket/ado/pr-${prNumber}-base`;
      // Force-update DevDocket-owned refs so force-pushed PR branches are reflected accurately.
      await this.runStep('fetch ADO source ref', () =>
        withPathContext(
          'Failed to fetch ADO source ref',
          'repo',
          clonePath,
          gitAdoAuth(
            ['fetch', 'origin', `+${sourceRef}:${headRef}`],
            clonePath,
            session.accessToken,
            300_000,
            cancellation.signal,
          ),
        ),
      );
      await this.runStep('fetch ADO target ref', () =>
        withPathContext(
          'Failed to fetch ADO target ref',
          'repo',
          clonePath,
          gitAdoAuth(
            ['fetch', 'origin', `+${targetRef}:${baseRef}`],
            clonePath,
            session.accessToken,
            300_000,
            cancellation.signal,
          ),
        ),
      );

      this.throwIfCancelled(token, cancellation.signal, 'validate worktree');
      const worktreeExists = await this.ensureValidGitDirectory(worktreePath, 'worktree', clonePath, cancellation.signal);
      if (worktreeExists) {
        this.log.info('Updating existing ADO worktree');
        await this.runStep('reset worktree', () =>
          withPathContext(
            'Failed to reset ADO worktree',
            'worktree',
            worktreePath,
            gitExec(['reset', '--hard', headRef], worktreePath, { signal: cancellation.signal }),
          ),
        );
      } else {
        if (cloneExists) {
          await this.runStep('prune worktree metadata', () => this.pruneWorktreeMetadata(clonePath, undefined, cancellation.signal));
        }
        this.log.info('Creating ADO worktree');
        await this.runStep('create worktree', () =>
          withPathContext(
            'Failed to create ADO worktree',
            'worktree',
            worktreePath,
            gitExec(['worktree', 'add', '--detach', worktreePath, headRef], clonePath, { signal: cancellation.signal }),
          ),
        );
      }

      const info: WorktreeInfo = {
        worktreePath,
        clonePath,
        org: `${org}/${project}`,
        repo,
        prNumber,
        headRef,
        baseRef,
        prUrl,
        provider: 'ado',
      };

      this.worktrees.set(key, info);
      validWorktreePaths.add(path.resolve(worktreePath));
      this.log.debug(`ensureAdoWorktree complete — worktree ready at ${worktreePath}`);
      return info;
    } finally {
      cancellation.dispose();
    }
  }

  /** Check if worktree already exists and return info, or undefined. */
  getWorktreeInfo(prUrl: string): WorktreeInfo | undefined {
    const key = this.keyForPrUrl(prUrl);
    if (!key) return undefined;
    const info = this.worktrees.get(key);
    this.log.debug(`getWorktreeInfo(${key}) — ${info ? 'hit' : 'miss'}`);
    return info;
  }

  /** Remove a single worktree. */
  async removeWorktree(prUrl: string, token?: vscode.CancellationToken): Promise<void> {
    this.log.debug(`removeWorktree called — prUrl: ${sanitizeUrlForLog(prUrl)}`);
    const key = this.keyForPrUrl(prUrl);
    if (!key) return;

    const info = this.worktrees.get(key);
    if (!info) {
      this.log.info(`removeWorktree — no cached worktree for ${key}`);
      return;
    }

    const cancellation = abortFromToken(token);
    try {
      this.throwIfCancelled(token, cancellation.signal, 'remove worktree');
      await this.runStep('remove worktree', () =>
        gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath, { signal: cancellation.signal }),
      );
      validWorktreePaths.delete(path.resolve(info.worktreePath));
      this.worktrees.delete(key);
      this.log.info(`Worktree removed for ${key}`);
    } finally {
      cancellation.dispose();
    }
  }

  /** Remove entire clone + all worktrees for a repo. */
  async removeRepo(org: string, repo: string, token?: vscode.CancellationToken): Promise<void> {
    this.log.info(`removeRepo called — ${org}/${repo}`);
    // Collect entries first to avoid mutation during iteration
    const toRemove = [...this.worktrees.entries()]
      .filter(([, info]) => info.org === org && info.repo === repo);

    const cancellation = abortFromToken(token);
    try {
      const repoBases = new Set<string>();
      for (const [key, info] of toRemove) {
        this.throwIfCancelled(token, cancellation.signal, 'remove worktree');
        repoBases.add(path.dirname(info.clonePath));
        try {
          await this.runStep('remove worktree', () =>
            gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath, { signal: cancellation.signal }),
          );
          this.log.info(`Removed worktree for ${key}`);
        } catch (err) {
          if (isAbortError(err)) {
            throw err;
          }
          this.log.warn(`Worktree for ${key} already gone — skipping`);
        }
        validWorktreePaths.delete(path.resolve(info.worktreePath));
        this.worktrees.delete(key);
      }

      if (repoBases.size === 0) {
        repoBases.add(path.join(this.storageUri.fsPath, 'repos', repoDirFor({ provider: 'github', org, repo })));
        const [adoOrg, project, ...rest] = org.split('/');
        if (adoOrg && project && rest.length === 0) {
          repoBases.add(path.join(this.storageUri.fsPath, 'repos', repoDirFor({ provider: 'ado', org: adoOrg, project, repo })));
        }
      }

      for (const repoBase of repoBases) {
        this.throwIfCancelled(token, cancellation.signal, 'delete repository directory');
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(repoBase), {
            recursive: true,
            useTrash: false,
          });
          this.log.debug(`Deleted repo directory: ${repoBase}`);
        } catch {
          this.log.debug(`Repo directory not found (already cleaned): ${repoBase}`);
        }
      }
    } finally {
      cancellation.dispose();
    }
  }

  private keyForPrUrl(prUrl: string): string | undefined {
    const github = parsePrUrl(prUrl);
    if (github) {
      return this.githubKey(github.org, github.repo, github.prNumber);
    }

    const ado = parseAdoPrUrl(prUrl);
    if (ado) {
      return this.adoKey(ado.org, ado.project, ado.repo, ado.prId);
    }

    return undefined;
  }

  private throwIfCancelled(token: vscode.CancellationToken | undefined, signal: AbortSignal | undefined, step: string): void {
    if (token?.isCancellationRequested || signal?.aborted) {
      this.log.info(`Cancellation detected before ${step}`);
      throw createStepAbortError(step);
    }
  }

  private async runStep<T>(step: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (isAbortError(err)) {
        const abortStep = err.step ?? step;
        this.log.info(`Cancellation received during ${abortStep}`);
        throw createStepAbortError(abortStep);
      }
      throw err;
    }
  }

  private githubKey(org: string, repo: string, prNumber: string): string {
    return `github:${org}/${repo}#${prNumber}`;
  }

  private adoKey(org: string, project: string, repo: string, prNumber: string): string {
    return `ado:${org}/${project}/${repo}#${prNumber}`;
  }

  private async ensureValidGitDirectory(
    dirPath: string,
    kind: 'repository' | 'worktree',
    clonePath?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!await this.directoryExists(dirPath)) {
      return false;
    }

    const label = kind === 'worktree' ? 'worktree' : 'repo';
    try {
      await this.runStep(`validate ${kind}`, () => gitExec(['rev-parse', '--git-dir'], dirPath, { signal }));
      const topLevel = (await this.runStep(
        `validate ${kind}`,
        () => gitExec(['rev-parse', '--show-toplevel'], dirPath, { signal }),
      )).trim();
      if (sameResolvedPath(topLevel, dirPath)) {
        return true;
      }
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      if (!isInvalidGitDirectoryError(err)) {
        throw pathContextError(`Failed to validate ${kind} directory`, label, dirPath, err);
      }
    }

    this.log.warn(`Found invalid/partial ${kind} dir at ${dirPath}; removing and recreating.`);
    await withPathContext(
      `Failed to remove invalid ${kind} directory`,
      label,
      dirPath,
      deleteDirectoryNoTrash(dirPath),
    );
    if (kind === 'worktree' && clonePath) {
      await this.pruneWorktreeMetadata(clonePath, 'Failed to prune invalid worktree metadata', signal);
    }
    return false;
  }

  private async pruneWorktreeMetadata(
    clonePath: string,
    operation = 'Failed to prune worktree metadata',
    signal?: AbortSignal,
  ): Promise<void> {
    await withPathContext(
      operation,
      'repo',
      clonePath,
      gitExec(['worktree', 'prune'], clonePath, { signal }),
    );
  }

  private async fetchPrMetadata(
    org: string,
    repo: string,
    prNumber: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ baseRef: string; headSha: string }> {
    const response = await fetch(
      `https://api.github.com/repos/${org}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: combineSignals(signal, 30_000),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status} fetching PR metadata`);
    }

    const data = (await response.json()) as { base: { ref: string }; head: { sha: string } };
    return { baseRef: data.base.ref, headSha: data.head.sha };
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dirPath));
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }
}

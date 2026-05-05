import * as vscode from 'vscode';
import * as path from 'path';
import { parseAdoPrUrl, parsePrUrl } from './prUrl';
import { ADO_AUTH_SCOPE, AdoPrClient } from './adoPrClient';
import { gitExec } from './tools/gitUtils';
import { validWorktreePaths } from './tools/worktreeRegistry';
import { isValidRef } from './tools/refValidation';

export { parsePrUrl };

/** Minimum git version required for GIT_CONFIG_COUNT env-based config injection. */
const MIN_GIT_VERSION = [2, 31] as const;
const UNSAFE_URL_CHARS = /[\s\x00-\x1f\x7f]/;

let gitVersionChecked = false;

/** Verify git >= 2.31 (needed for GIT_CONFIG_COUNT env vars). Runs once. */
async function ensureGitVersion(): Promise<void> {
  if (gitVersionChecked) return;
  const raw = await gitExec(['version'], '.');
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
async function gitAuth(args: string[], cwd: string, token: string, timeout = 30_000): Promise<string> {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return gitWithExtraHeader(args, cwd, `Authorization: Basic ${encoded}`, timeout);
}

async function gitWithExtraHeader(args: string[], cwd: string, extraHeader: string, timeout = 30_000): Promise<string> {
  await ensureGitVersion();
  return gitExec(args, cwd, {
    timeout,
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: extraHeader,
    },
  });
}

async function gitAdoAuth(args: string[], cwd: string, token: string, timeout = 30_000): Promise<string> {
  return gitWithExtraHeader(args, cwd, `Authorization: Bearer ${token}`, timeout);
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
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

async function configureLongPaths(clonePath: string): Promise<void> {
  if (process.platform === 'win32') {
    await gitExec(['config', '--local', 'core.longpaths', 'true'], clonePath);
  }
}

export class RepoManager {
  private worktrees = new Map<string, WorktreeInfo>();

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Clone repo if needed, create worktree if needed, fetch + checkout PR branch. */
  async ensureWorktree(prUrl: string): Promise<WorktreeInfo> {
    const logPrUrl = sanitizeUrlForLog(prUrl);
    this.log.debug(`ensureWorktree called — prUrl: ${logPrUrl}`);
    const github = parsePrUrl(prUrl);
    if (github) {
      return this.ensureGitHubWorktree(prUrl, github.org, github.repo, github.prNumber);
    }

    const ado = parseAdoPrUrl(prUrl);
    if (ado) {
      return this.ensureAdoWorktree(prUrl, ado.org, ado.project, ado.repo, ado.prId);
    }

    this.log.error(`Invalid PR URL: ${logPrUrl}`);
    throw new Error(`Invalid PR URL: ${logPrUrl}`);
  }

  private async ensureGitHubWorktree(prUrl: string, org: string, repo: string, prNumber: string): Promise<WorktreeInfo> {
    const key = this.githubKey(org, repo, prNumber);
    this.log.info(`Parsed GitHub PR: org=${org}, repo=${repo}, prNumber=${prNumber}`);

    const repoDir = `${org}-${repo}`;
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const clonePath = path.join(repoBase, 'clone');
    const worktreePath = path.join(repoBase, 'worktrees', `pr-${prNumber}`);
    this.log.debug(`Paths — clonePath: ${clonePath}, worktreePath: ${worktreePath}`);

    this.log.info('Requesting GitHub auth session');
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    if (!session) {
      this.log.error('GitHub authentication not available');
      throw new Error('GitHub authentication required');
    }
    this.log.debug(`GitHub auth obtained — account: ${session.account?.label ?? 'unknown'}`);

    const cloneUrl = `https://github.com/${org}/${repo}.git`;
    const cloneExists = await this.directoryExists(clonePath);
    this.log.debug(`Clone directory exists: ${cloneExists}`);
    if (!cloneExists) {
      this.log.info('Cloning repository');
      this.log.debug(`Clone destination: ${clonePath}`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(clonePath)));
      await gitAuth(
        cloneArgs(['clone', '--no-checkout', cloneUrl, clonePath]),
        path.dirname(clonePath),
        session.accessToken,
        300_000,
      );
      this.log.info('Clone complete');
    }
    await configureLongPaths(clonePath);

    this.log.info('Fetching PR metadata from GitHub API');
    const prMeta = await this.fetchPrMetadata(org, repo, prNumber, session.accessToken);
    const baseRef = prMeta.baseRef;
    const headRef = `pr-${prNumber}`;

    if (!isValidRef(baseRef)) {
      const safeBaseRef = JSON.stringify(baseRef);
      this.log.error(`Invalid base ref from GitHub API: ${safeBaseRef}`);
      throw new Error(`Invalid base ref from GitHub API: ${safeBaseRef}`);
    }
    this.log.info(`PR metadata — baseRef: ${baseRef}, headSha: ${prMeta.headSha}, local headRef: ${headRef}`);

    const worktreeExists = await this.directoryExists(worktreePath);
    this.log.debug(`Worktree directory exists: ${worktreeExists}`);
    if (worktreeExists) {
      this.log.info('Updating existing worktree — fetching PR head');
      await gitAuth(['fetch', 'origin', `pull/${prNumber}/head`], worktreePath, session.accessToken, 300_000);
      await gitExec(['reset', '--hard', 'FETCH_HEAD'], worktreePath);
      this.log.info('Worktree updated');
    } else {
      this.log.info('Creating new worktree — fetching PR head');
      await gitAuth(['fetch', 'origin', `pull/${prNumber}/head:${headRef}`], clonePath, session.accessToken, 300_000);
      this.log.info('PR head fetched');
    }

    this.log.info(`Fetching base branch: ${baseRef}`);
    await gitAuth(
      ['fetch', 'origin', `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
      clonePath,
      session.accessToken,
      300_000,
    );
    this.log.info('Base branch fetched');

    if (!worktreeExists) {
      this.log.info('Creating worktree');
      this.log.debug(`Worktree destination: ${worktreePath}, ref: ${headRef}`);
      await gitExec(['worktree', 'add', worktreePath, headRef], clonePath);
      this.log.info('Worktree created');
    }

    const info: WorktreeInfo = {
      worktreePath,
      clonePath,
      org,
      repo,
      prNumber,
      headRef,
      baseRef: `origin/${baseRef}`,
      prUrl,
      provider: 'github',
    };

    this.worktrees.set(key, info);
    validWorktreePaths.add(path.resolve(worktreePath));
    this.log.debug(`ensureWorktree complete — worktree ready at ${worktreePath}`);
    return info;
  }

  private async ensureAdoWorktree(
    prUrl: string,
    org: string,
    project: string,
    repo: string,
    prNumber: string,
  ): Promise<WorktreeInfo> {
    const key = this.adoKey(org, project, repo, prNumber);
    this.log.info(`Parsed ADO PR: org=${org}, project=${project}, repo=${repo}, prNumber=${prNumber}`);

    const repoDir = sanitizePathSegment(`ado-${org}-${project}-${repo}`);
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const clonePath = path.join(repoBase, 'clone');
    const worktreePath = path.join(repoBase, 'worktrees', `pr-${prNumber}`);
    this.log.debug(`ADO paths — clonePath: ${clonePath}, worktreePath: ${worktreePath}`);

    const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
      createIfNone: true,
    });
    if (!session) {
      this.log.error('Microsoft authentication not available');
      throw new Error('Azure DevOps authentication required');
    }

    const details = await new AdoPrClient(fetch, async () => session).fetchPullRequestDetails({ org, project, repo, prId: prNumber });
    if (!details) {
      throw new Error('Azure DevOps authentication required');
    }

    const sourceRef = details.sourceRefName;
    const targetRef = details.targetRefName;
    if (!sourceRef || !targetRef || !isValidRef(sourceRef) || !isValidRef(targetRef)) {
      throw new Error('Azure DevOps PR metadata contained missing or invalid source or target refs');
    }

    const cloneUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
    if (!isValidCloneUrl(cloneUrl)) {
      throw new Error('Azure DevOps repository clone URL is invalid');
    }

    const cloneExists = await this.directoryExists(clonePath);
    if (!cloneExists) {
      this.log.info('Cloning Azure Repos repository');
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(clonePath)));
      await gitAdoAuth(
        cloneArgs(['clone', '--no-checkout', cloneUrl, clonePath]),
        path.dirname(clonePath),
        session.accessToken,
        300_000,
      );
      this.log.info('ADO clone complete');
    }
    await configureLongPaths(clonePath);

    const headRef = `refs/devdocket/ado/pr-${prNumber}-head`;
    const baseRef = `refs/devdocket/ado/pr-${prNumber}-base`;
    // Force-update DevDocket-owned refs so force-pushed PR branches are reflected accurately.
    await gitAdoAuth(['fetch', 'origin', `+${sourceRef}:${headRef}`], clonePath, session.accessToken, 300_000);
    await gitAdoAuth(['fetch', 'origin', `+${targetRef}:${baseRef}`], clonePath, session.accessToken, 300_000);

    const worktreeExists = await this.directoryExists(worktreePath);
    if (worktreeExists) {
      this.log.info('Updating existing ADO worktree');
      await gitExec(['reset', '--hard', headRef], worktreePath);
    } else {
      this.log.info('Creating ADO worktree');
      await gitExec(['worktree', 'add', '--detach', worktreePath, headRef], clonePath);
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
  async removeWorktree(prUrl: string): Promise<void> {
    this.log.debug(`removeWorktree called — prUrl: ${sanitizeUrlForLog(prUrl)}`);
    const key = this.keyForPrUrl(prUrl);
    if (!key) return;

    const info = this.worktrees.get(key);
    if (!info) {
      this.log.info(`removeWorktree — no cached worktree for ${key}`);
      return;
    }

    await gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath);
    validWorktreePaths.delete(path.resolve(info.worktreePath));
    this.worktrees.delete(key);
    this.log.info(`Worktree removed for ${key}`);
  }

  /** Remove entire clone + all worktrees for a repo. */
  async removeRepo(org: string, repo: string): Promise<void> {
    this.log.info(`removeRepo called — ${org}/${repo}`);
    // Collect entries first to avoid mutation during iteration
    const toRemove = [...this.worktrees.entries()]
      .filter(([, info]) => info.org === org && info.repo === repo);

    const repoBases = new Set<string>();
    for (const [key, info] of toRemove) {
      repoBases.add(path.dirname(info.clonePath));
      try {
        await gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath);
        this.log.info(`Removed worktree for ${key}`);
      } catch {
        this.log.warn(`Worktree for ${key} already gone — skipping`);
      }
      validWorktreePaths.delete(path.resolve(info.worktreePath));
      this.worktrees.delete(key);
    }

    if (repoBases.size === 0) {
      repoBases.add(path.join(this.storageUri.fsPath, 'repos', sanitizePathSegment(`${org}-${repo}`)));
      if (org.includes('/')) {
        repoBases.add(path.join(this.storageUri.fsPath, 'repos', sanitizePathSegment(`ado-${org}-${repo}`)));
      }
    }

    for (const repoBase of repoBases) {
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

  private githubKey(org: string, repo: string, prNumber: string): string {
    return `github:${org}/${repo}#${prNumber}`;
  }

  private adoKey(org: string, project: string, repo: string, prNumber: string): string {
    return `ado:${org}/${project}/${repo}#${prNumber}`;
  }

  private async fetchPrMetadata(
    org: string,
    repo: string,
    prNumber: string,
    token: string,
  ): Promise<{ baseRef: string; headSha: string }> {
    const response = await fetch(
      `https://api.github.com/repos/${org}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
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

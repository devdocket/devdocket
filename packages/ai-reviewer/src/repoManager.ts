import * as vscode from 'vscode';
import * as path from 'path';
import { parsePrUrl } from './prUrl';
import { gitExec } from './tools/gitUtils';
import { validWorktreePaths } from './tools/worktreeRegistry';

export { parsePrUrl };

export interface WorktreeInfo {
  worktreePath: string;
  clonePath: string;
  org: string;
  repo: string;
  prNumber: string;
  headRef: string;
  baseRef: string;
}

/** Build a Basic auth header value for transient git authentication. */
function authHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Authorization: Basic ${encoded}`;
}

/** Run a git command with transient auth injected via http.extraheader. */
function gitAuth(args: string[], cwd: string, token: string, timeout = 30_000): Promise<string> {
  return gitExec(
    ['-c', `http.extraheader=${authHeader(token)}`, ...args],
    cwd,
    timeout,
  );
}

export class RepoManager {
  private worktrees = new Map<string, WorktreeInfo>();

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Clone repo if needed, create worktree if needed, fetch + checkout PR branch. */
  async ensureWorktree(prUrl: string): Promise<WorktreeInfo> {
    this.log.debug(`ensureWorktree called — prUrl: ${prUrl}`);
    const parts = parsePrUrl(prUrl);
    if (!parts) {
      this.log.error(`Invalid GitHub PR URL: ${prUrl}`);
      throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
    }

    const { org, repo, prNumber } = parts;
    const key = `${org}/${repo}#${prNumber}`;
    this.log.info(`Parsed PR: org=${org}, repo=${repo}, prNumber=${prNumber}`);

    const repoDir = `${org}-${repo}`;
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const clonePath = path.join(repoBase, 'clone');
    const worktreePath = path.join(repoBase, 'worktrees', `pr-${prNumber}`);
    this.log.debug(`Paths — clonePath: ${clonePath}, worktreePath: ${worktreePath}`);

    // Get GitHub auth token
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

    // Clone if needed (token injected transiently, not persisted in remote)
    const cloneExists = await this.directoryExists(clonePath);
    this.log.debug(`Clone directory exists: ${cloneExists}`);
    if (!cloneExists) {
      this.log.info('Cloning repository');
      this.log.debug(`Clone destination: ${clonePath}`);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(clonePath)),
      );
      await gitAuth(
        ['clone', '--no-checkout', cloneUrl, clonePath],
        path.dirname(clonePath),
        session.accessToken,
        300_000,
      );
      this.log.info('Clone complete');
    }

    // Fetch PR metadata from GitHub API to get base ref
    this.log.info('Fetching PR metadata from GitHub API');
    const prMeta = await this.fetchPrMetadata(org, repo, prNumber, session.accessToken);
    const baseRef = prMeta.baseRef;
    const headRef = `pr-${prNumber}`;
    this.log.info(`PR metadata — baseRef: ${baseRef}, headSha: ${prMeta.headSha}, local headRef: ${headRef}`);

    // Fetch PR head ref and base branch
    const worktreeExists = await this.directoryExists(worktreePath);
    this.log.debug(`Worktree directory exists: ${worktreeExists}`);
    if (worktreeExists) {
      this.log.info('Updating existing worktree — fetching PR head');
      await gitAuth(
        ['fetch', 'origin', `pull/${prNumber}/head`],
        worktreePath,
        session.accessToken,
        300_000,
      );
      await gitExec(['reset', '--hard', 'FETCH_HEAD'], worktreePath);
      this.log.info('Worktree updated');
    } else {
      this.log.info('Creating new worktree — fetching PR head');
      await gitAuth(
        ['fetch', 'origin', `pull/${prNumber}/head:${headRef}`],
        clonePath,
        session.accessToken,
        300_000,
      );
      this.log.info('PR head fetched');
    }

    // Fetch base branch for diffs (validate ref from API)
    if (/^-|\s/.test(baseRef)) {
      this.log.error(`Invalid base ref from GitHub API: ${baseRef}`);
      throw new Error(`Invalid base ref from GitHub API: ${baseRef}`);
    }
    this.log.info(`Fetching base branch: ${baseRef}`);
    await gitAuth(
      ['fetch', 'origin', `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
      clonePath,
      session.accessToken,
      300_000,
    );
    this.log.info('Base branch fetched');

    // Create worktree if it doesn't exist yet
    if (!worktreeExists) {
      this.log.info('Creating worktree');
      this.log.debug(`Worktree destination: ${worktreePath}, ref: ${headRef}`);
      await gitExec(
        ['worktree', 'add', worktreePath, headRef],
        clonePath,
      );
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
    };

    this.worktrees.set(key, info);
    validWorktreePaths.add(path.resolve(worktreePath));
    this.log.debug(`ensureWorktree complete — worktree ready at ${worktreePath}`);
    return info;
  }

  /** Check if worktree already exists and return info, or undefined. */
  getWorktreeInfo(prUrl: string): WorktreeInfo | undefined {
    const parts = parsePrUrl(prUrl);
    if (!parts) return undefined;
    const key = `${parts.org}/${parts.repo}#${parts.prNumber}`;
    const info = this.worktrees.get(key);
    this.log.debug(`getWorktreeInfo(${key}) — ${info ? 'hit' : 'miss'}`);
    return info;
  }

  /** Remove a single worktree. */
  async removeWorktree(prUrl: string): Promise<void> {
    this.log.debug(`removeWorktree called — prUrl: ${prUrl}`);
    const parts = parsePrUrl(prUrl);
    if (!parts) return;

    const key = `${parts.org}/${parts.repo}#${parts.prNumber}`;
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

    for (const [key, info] of toRemove) {
      try {
        await gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath);
        this.log.info(`Removed worktree for ${key}`);
      } catch {
        this.log.warn(`Worktree for ${key} already gone — skipping`);
      }
      validWorktreePaths.delete(path.resolve(info.worktreePath));
      this.worktrees.delete(key);
    }

    const repoDir = `${org}-${repo}`;
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
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

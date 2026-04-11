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
function gitAuth(args: string[], cwd: string, token: string): Promise<string> {
  return gitExec(
    ['-c', `http.extraheader=${authHeader(token)}`, ...args],
    cwd,
  );
}

export class RepoManager {
  private worktrees = new Map<string, WorktreeInfo>();

  constructor(private readonly storageUri: vscode.Uri) {}

  /** Clone repo if needed, create worktree if needed, fetch + checkout PR branch. */
  async ensureWorktree(prUrl: string): Promise<WorktreeInfo> {
    const parts = parsePrUrl(prUrl);
    if (!parts) {
      throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
    }

    const { org, repo, prNumber } = parts;
    const key = `${org}/${repo}#${prNumber}`;

    const repoDir = `${org}-${repo}`;
    const repoBase = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const clonePath = path.join(repoBase, 'clone');
    const worktreePath = path.join(repoBase, 'worktrees', `pr-${prNumber}`);

    // Get GitHub auth token
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    if (!session) {
      throw new Error('GitHub authentication required');
    }

    const cloneUrl = `https://github.com/${org}/${repo}.git`;

    // Clone if needed (token injected transiently, not persisted in remote)
    const cloneExists = await this.directoryExists(clonePath);
    if (!cloneExists) {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(clonePath)),
      );
      await gitAuth(
        ['clone', '--no-checkout', cloneUrl, clonePath],
        path.dirname(clonePath),
        session.accessToken,
      );
    }

    // Fetch PR metadata from GitHub API to get base ref
    const prMeta = await this.fetchPrMetadata(org, repo, prNumber, session.accessToken);
    const baseRef = prMeta.baseRef;
    const headRef = `pr-${prNumber}`;

    // Fetch PR head ref and base branch
    const worktreeExists = await this.directoryExists(worktreePath);
    if (worktreeExists) {
      // Worktree already exists — fetch to FETCH_HEAD to avoid
      // "refusing to fetch into branch checked out" error, then update in-place
      await gitAuth(
        ['fetch', 'origin', `pull/${prNumber}/head`],
        worktreePath,
        session.accessToken,
      );
      await gitExec(['reset', '--hard', 'FETCH_HEAD'], worktreePath);
    } else {
      // First time — create the local branch and worktree
      await gitAuth(
        ['fetch', 'origin', `pull/${prNumber}/head:${headRef}`],
        clonePath,
        session.accessToken,
      );
    }

    // Fetch base branch for diffs (validate ref from API)
    if (/^-|\s/.test(baseRef)) {
      throw new Error(`Invalid base ref from GitHub API: ${baseRef}`);
    }
    await gitAuth(
      ['fetch', 'origin', `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
      clonePath,
      session.accessToken,
    );

    // Create worktree if it doesn't exist yet
    if (!worktreeExists) {
      await gitExec(
        ['worktree', 'add', worktreePath, headRef],
        clonePath,
      );
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
    return info;
  }

  /** Check if worktree already exists and return info, or undefined. */
  getWorktreeInfo(prUrl: string): WorktreeInfo | undefined {
    const parts = parsePrUrl(prUrl);
    if (!parts) return undefined;
    const key = `${parts.org}/${parts.repo}#${parts.prNumber}`;
    return this.worktrees.get(key);
  }

  /** Remove a single worktree. */
  async removeWorktree(prUrl: string): Promise<void> {
    const parts = parsePrUrl(prUrl);
    if (!parts) return;

    const key = `${parts.org}/${parts.repo}#${parts.prNumber}`;
    const info = this.worktrees.get(key);
    if (!info) return;

    await gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath);
    validWorktreePaths.delete(path.resolve(info.worktreePath));
    this.worktrees.delete(key);
  }

  /** Remove entire clone + all worktrees for a repo. */
  async removeRepo(org: string, repo: string): Promise<void> {
    // Collect entries first to avoid mutation during iteration
    const toRemove = [...this.worktrees.entries()]
      .filter(([, info]) => info.org === org && info.repo === repo);

    for (const [key, info] of toRemove) {
      try {
        await gitExec(['worktree', 'remove', '--force', info.worktreePath], info.clonePath);
      } catch {
        // Worktree may already be gone
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
    } catch {
      // Directory may not exist
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

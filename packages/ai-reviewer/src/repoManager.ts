import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';

export interface WorktreeInfo {
  worktreePath: string;
  clonePath: string;
  org: string;
  repo: string;
  prNumber: string;
  headRef: string;
  baseRef: string;
}

interface PrUrlParts {
  org: string;
  repo: string;
  prNumber: string;
}

function parsePrUrl(url: string): PrUrlParts | undefined {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[\/?#])/,
  );
  if (!match) return undefined;
  return { org: match[1], repo: match[2], prNumber: match[3] };
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', ...args], { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
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
    const clonePath = path.join(this.storageUri.fsPath, 'repos', repoDir);
    const worktreePath = path.join(clonePath, 'worktrees', `pr-${prNumber}`);

    // Get GitHub auth token
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    if (!session) {
      throw new Error('GitHub authentication required');
    }

    const cloneUrl = `https://x-access-token:${session.accessToken}@github.com/${org}/${repo}.git`;

    // Clone if needed
    const cloneExists = await this.directoryExists(clonePath);
    if (!cloneExists) {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(clonePath)),
      );
      await git(
        ['clone', '--no-checkout', cloneUrl, clonePath],
        path.dirname(clonePath),
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
      await git(
        ['fetch', 'origin', `pull/${prNumber}/head`],
        worktreePath,
      );
      await git(['reset', '--hard', 'FETCH_HEAD'], worktreePath);
    } else {
      // First time — create the local branch and worktree
      await git(
        ['fetch', 'origin', `pull/${prNumber}/head:${headRef}`],
        clonePath,
      );
    }

    // Fetch base branch for diffs
    await git(['fetch', 'origin', baseRef], clonePath);

    // Create worktree if it doesn't exist yet
    if (!worktreeExists) {
      await git(
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

    await git(['worktree', 'remove', info.worktreePath, '--force'], info.clonePath);
    this.worktrees.delete(key);
  }

  /** Remove entire clone + all worktrees for a repo. */
  async removeRepo(org: string, repo: string): Promise<void> {
    // Remove all worktrees for this repo from the map
    for (const [key, info] of this.worktrees) {
      if (info.org === org && info.repo === repo) {
        this.worktrees.delete(key);
      }
    }

    const repoDir = `${org}-${repo}`;
    const clonePath = path.join(this.storageUri.fsPath, 'repos', repoDir);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(clonePath), {
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

export { parsePrUrl };

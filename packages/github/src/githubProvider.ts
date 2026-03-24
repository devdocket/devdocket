import * as vscode from 'vscode';

interface Disposable {
  dispose(): void;
}

interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

interface WorkCenterProvider {
  readonly id: string;
  readonly label: string;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(): Promise<void>;
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  html_url: string;
  repository_url: string;
}

export class GitHubIssueProvider implements WorkCenterProvider {
  readonly id = 'github';
  readonly label = 'GitHub Issues';

  private readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    if (intervalSeconds <= 0) {
      // Disable periodic refresh if interval is 0 or negative
      return;
    }
    // Clamp to minimum of 60 seconds
    const clampedInterval = Math.max(intervalSeconds, 60);
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        console.error('WorkCenter GitHub: refresh failed:', err);
      });
    }, clampedInterval * 1000);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true,
      }).catch(() => null);
      
      if (!session) {
        return;
      }

      const repos = this.getConfiguredRepos();
      const { issues, failures } = await this.fetchAssignedIssues(session.accessToken, repos);

      const items: DiscoveredItem[] = issues.map((issue) => {
        const repoName = this.parseRepo(issue.html_url);
        return {
          externalId: `${repoName}#${issue.number}`,
          title: `#${issue.number}: ${issue.title}`,
          description: issue.body?.slice(0, 200),
          url: issue.html_url,
          group: repoName,
        };
      });

      this._onDidDiscoverItems.fire(items);

      if (failures.length > 0) {
        const message = failures.length === 1
          ? `Failed to fetch issues from ${failures[0]}`
          : `Failed to fetch issues from ${failures.length} repositories`;
        vscode.window.showWarningMessage(`WorkCenter GitHub: ${message}`);
      }
    } catch (err) {
      console.error('WorkCenter GitHub: failed to fetch issues:', err);
    }
  }

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('workcenterGithub');
    return config.get<string[]>('repos', []);
  }

  private parseRepo(htmlUrl: string): string {
    const match = htmlUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    if (!match) {
      console.warn(`WorkCenter GitHub: failed to parse repo from URL: ${htmlUrl}`);
      return `unknown-repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    return match[1];
  }

  private async fetchAssignedIssues(
    token: string,
    repos: string[],
  ): Promise<{ issues: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      const allIssues: GitHubIssue[] = [];
      const failures: string[] = [];
      for (const repo of repos) {
        const { issues, failed } = await this.fetchRepoIssues(token, repo);
        allIssues.push(...issues);
        if (failed) {
          failures.push(repo);
        }
      }
      return { issues: allIssues, failures };
    }

    // Fallback: fetch all assigned issues across all repos
    const { issues, failed } = await this.fetchAllAssignedIssues(token);
    return { issues, failures: failed ? ['all repositories'] : [] };
  }

  private async fetchRepoIssues(token: string, repo: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues?assignee=@me&state=open&per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      console.error(`WorkCenter GitHub: failed to fetch issues for ${repo}: ${response.status}`);
      return { issues: [], failed: true };
    }

    return { issues: (await response.json()) as GitHubIssue[], failed: false };
  }

  private async fetchAllAssignedIssues(token: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    const response = await fetch(
      'https://api.github.com/issues?filter=assigned&state=open&per_page=50',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      console.error(`WorkCenter GitHub: failed to fetch assigned issues: ${response.status}`);
      return { issues: [], failed: true };
    }

    return { issues: (await response.json()) as GitHubIssue[], failed: false };
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}

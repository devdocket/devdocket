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
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        console.error('WorkCenter GitHub: refresh failed:', err);
      });
    }, intervalSeconds * 1000);
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
      });
      if (!session) {
        return;
      }

      const repos = this.getConfiguredRepos();
      const issues = await this.fetchAssignedIssues(session.accessToken, repos);

      const items: DiscoveredItem[] = issues.map((issue) => ({
        externalId: `github-issue-${issue.html_url}`,
        title: `#${issue.number}: ${issue.title}`,
        description: issue.body?.slice(0, 200),
        url: issue.html_url,
        group: this.parseRepo(issue.html_url),
      }));

      this._onDidDiscoverItems.fire(items);
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
    return match?.[1] ?? '';
  }

  private async fetchAssignedIssues(
    token: string,
    repos: string[],
  ): Promise<GitHubIssue[]> {
    if (repos.length > 0) {
      const allIssues: GitHubIssue[] = [];
      for (const repo of repos) {
        const issues = await this.fetchRepoIssues(token, repo);
        allIssues.push(...issues);
      }
      return allIssues;
    }

    // Fallback: fetch all assigned issues across all repos
    return this.fetchAllAssignedIssues(token);
  }

  private async fetchRepoIssues(token: string, repo: string): Promise<GitHubIssue[]> {
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
      return [];
    }

    return (await response.json()) as GitHubIssue[];
  }

  private async fetchAllAssignedIssues(token: string): Promise<GitHubIssue[]> {
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
      return [];
    }

    return (await response.json()) as GitHubIssue[];
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}

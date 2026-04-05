import * as vscode from 'vscode';
import { logger } from './logger';
import { BaseGitHubProvider, DiscoveredItem, GitHubIssue } from './baseGithubProvider';

export class GitHubIssueProvider extends BaseGitHubProvider {
  readonly id = 'github';
  readonly label = 'GitHub Issues';

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void> {
    logger.info('Fetching assigned issues...');
    const repos = this.getConfiguredRepos();
    const { issues, failures } = await this.fetchAssignedIssues(accessToken, repos);

    const items: DiscoveredItem[] = issues.map((issue) => {
      const repoName = this.parseRepo(issue);
      return {
        externalId: `${repoName}#${issue.number}`,
        title: `#${issue.number}: ${issue.title}`,
        description: issue.body?.slice(0, 200),
        url: issue.html_url,
        group: repoName,
      };
    });

    logger.info(`Discovered ${items.length} GitHub issues`);
    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch issues from ${failures[0]}`
        : `Failed to fetch issues from ${failures.length} repositories`;
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`WorkCenter GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
    }
  }

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('workcenterGithub');
    return config.get<string[]>('repos', []);
  }

  private async fetchAssignedIssues(
    token: string,
    repos: string[],
  ): Promise<{ issues: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      const results = await Promise.allSettled(
        repos.map(repo => this.fetchRepoIssues(token, repo))
      );

      const allIssues: GitHubIssue[] = [];
      const failures: string[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { issues, failed } = result.value;
          allIssues.push(...issues);
          if (failed) {
            failures.push(repos[index]);
          }
        } else {
          failures.push(repos[index]);
        }
      });

      return { issues: allIssues, failures };
    }

    // Fallback: fetch all assigned issues across all repos
    const { issues, failed } = await this.fetchAllAssignedIssues(token);
    return { issues, failures: failed ? ['all repositories'] : [] };
  }

  private async fetchRepoIssues(token: string, repo: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    logger.debug(`Fetching issues for repo: ${repo}`);
    // GitHub API max per_page is 100; pagination for >100 items is a future enhancement
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues?assignee=@me&state=open&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      logger.error(`Failed to fetch issues for ${repo}: ${response.status}`);
      return { issues: [], failed: true };
    }

    const items = (await response.json()) as GitHubIssue[];
    // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
    const issues = items.filter(item => !item.pull_request);
    return { issues, failed: false };
  }

  private async fetchAllAssignedIssues(token: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    // GitHub API max per_page is 100; pagination for >100 items is a future enhancement
    const response = await fetch(
      'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      logger.error(`Failed to fetch assigned issues: ${response.status}`);
      return { issues: [], failed: true };
    }

    const items = (await response.json()) as GitHubIssue[];
    // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
    const issues = items.filter(item => !item.pull_request);
    return { issues, failed: false };
  }
}

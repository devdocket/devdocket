import * as vscode from 'vscode';
import { isValidGitHubRepo } from '@workcenter/shared';
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
      const validRepos: string[] = [];
      for (const repo of repos) {
        if (isValidGitHubRepo(repo)) {
          validRepos.push(repo);
        } else {
          logger.warn('Skipping invalid repo identifier', repo);
        }
      }

      const failures: string[] = [];

      const results = await Promise.allSettled(
        validRepos.map(repo => this.fetchRepoIssues(token, repo))
      );

      const allIssues: GitHubIssue[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { issues, failed } = result.value;
          allIssues.push(...issues);
          if (failed) {
            failures.push(validRepos[index]);
          }
        } else {
          failures.push(validRepos[index]);
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
    try {
      const items = await this.fetchPaginated<GitHubIssue>(
        `https://api.github.com/repos/${repo}/issues?assignee=@me&state=open&per_page=100`,
        token,
      );
      // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
      const issues = items.filter(item => !item.pull_request);
      return { issues, failed: false };
    } catch (err) {
      logger.error(`Failed to fetch issues for ${repo}`, err);
      return { issues: [], failed: true };
    }
  }

  private async fetchAllAssignedIssues(token: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    try {
      const items = await this.fetchPaginated<GitHubIssue>(
        'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
        token,
      );
      // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
      const issues = items.filter(item => !item.pull_request);
      return { issues, failed: false };
    } catch (err) {
      logger.error('Failed to fetch assigned issues', err);
      return { issues: [], failed: true };
    }
  }

  private async fetchPaginated<T>(url: string, token: string, maxPages: number = 10): Promise<T[]> {
    const allItems: T[] = [];
    let nextUrl: string | null = url;
    let page = 0;

    while (nextUrl && page < maxPages) {
      let response: Response;
      try {
        response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch (err) {
        if (allItems.length > 0) {
          logger.warn(
            `Network error on page ${page + 1}. ` +
            `Returning ${allItems.length} items from previous pages.`,
            err,
          );
          return allItems;
        }
        throw err;
      }

      if (!response.ok) {
        if (allItems.length > 0) {
          logger.warn(
            `GitHub API returned ${response.status} on page ${page + 1}. ` +
            `Returning ${allItems.length} items from previous pages.`,
          );
          return allItems;
        }
        throw new Error(`GitHub API returned ${response.status}`);
      }

      const items = (await response.json()) as T[];
      allItems.push(...items);

      nextUrl = this.getNextPageUrl(response.headers.get('link'));
      page++;
    }

    if (nextUrl) {
      logger.warn(`Pagination limit reached (${maxPages} pages). Some items may not be shown.`);
    }

    return allItems;
  }

  private getNextPageUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }
}

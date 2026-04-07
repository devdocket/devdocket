import * as vscode from 'vscode';
import { logger } from './logger';
import type { DiscoveredItem } from '@workcenter/shared';
import { BaseGitHubProvider, GitHubIssue } from './baseGithubProvider';

interface GitHubSearchResponse {
  items: GitHubIssue[];
}

export class GitHubPrReviewProvider extends BaseGitHubProvider {
  readonly id = 'github-pr-reviews';
  readonly label = 'GitHub PR Reviews';
  readonly resurfaceDismissed = true;

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void> {
    logger.info('Fetching PR review requests...');
    const response = await fetch(
      'https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      const message = 'Failed to fetch PR review requests';
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`WorkCenter GitHub: ${message}`);
      } else {
        logger.warn(`${message}: ${response.status}`);
      }
      return;
    }

    const data = (await response.json()) as GitHubSearchResponse;
    logger.info(`Discovered ${data.items.length} PR review requests`);
    const items: DiscoveredItem[] = data.items.map((pr) => {
      const repoName = this.parseRepo(pr);
      return {
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body?.slice(0, 200),
        url: pr.html_url,
        group: repoName,
      };
    });

    this._onDidDiscoverItems.fire(items);
  }

  // Override: use repository_url as-is to maintain unique externalId
  protected override parseRepo(issue: GitHubIssue): string {
    const match = issue.html_url.match(/github\.com\/([^/]+\/[^/]+)/);
    if (match) {
      return match[1];
    }

    const apiMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)/);
    if (apiMatch) {
      return apiMatch[1];
    }

    logger.warn(`Could not parse repo from PR URL: ${issue.html_url}`);
    return issue.repository_url;
  }
}

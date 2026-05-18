import { combineSignals, createAbortError, runWorkerPool, type ProviderItem } from '@devdocket/shared';
import { BaseAdoPrProvider, buildAdoMyPrsStateBadge, type AdoPullRequest } from './baseAdoPrProvider';
import { logger } from './logger';
import type { OrgConfig } from './configParser';

export class AdoMyPrsProvider extends BaseAdoPrProvider {
  readonly id = 'ado-my-prs';
  readonly label = 'My Azure DevOps PRs';

  protected readonly searchCriteriaParam = 'creatorId' as const;
  protected readonly itemReason = 'You authored this PR';
  protected readonly logLabel = 'My PRs';

  constructor(orgConfigs: OrgConfig[]) {
    super(orgConfigs);
  }

  protected override mapPrToItem(pr: AdoPullRequest, org: string): ProviderItem {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { resurfaceVersion: _resurfaceVersion, ...item } = super.mapPrToItem(pr, org);
    const authoredItem = { ...item, authored: true };
    if (pr.isDraft) {
      const badge = buildAdoMyPrsStateBadge('Draft');
      return { ...authoredItem, state: 'Draft', ...(badge ? { badges: [badge] } : {}) };
    }
    return authoredItem;
  }

  protected override async postProcessItems(items: ProviderItem[], token: string, signal?: AbortSignal): Promise<void> {
    const candidates = items
      .map((item, index) => ({ item, index, parsed: this.parsePrExternalId(item.externalId) }))
      .filter(
        (entry): entry is { item: ProviderItem; index: number; parsed: NonNullable<ReturnType<AdoMyPrsProvider['parsePrExternalId']>> } =>
          entry.item.state !== 'Draft' && entry.parsed !== undefined,
      );

    await runWorkerPool(candidates, async ({ item, index, parsed }) => {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const detailUrl = `https://dev.azure.com/${encodeURIComponent(parsed.org)}/${encodeURIComponent(parsed.project)}/_apis/git/repositories/${encodeURIComponent(parsed.repo)}/pullrequests/${parsed.prId}?api-version=7.1`;

      // runWorkerPool processes candidates concurrently, but each worker only writes back
      // to the unique index captured when candidates was built, so mutating items[index]
      // in place is safe here.
      try {
        const response = await fetch(detailUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: combineSignals(signal, 30_000),
        });

        if (!response.ok) {
          logger.debug(`Failed to fetch PR detail for ${item.externalId}: ${response.status}`);
          return;
        }

        const detail = (await response.json()) as AdoPullRequest;
        const voteState = this.getVoteStatus(detail);
        const badge = buildAdoMyPrsStateBadge(voteState);
        items[index] = {
          ...item,
          state: voteState,
          ...(badge ? { badges: [badge] } : {}),
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
          throw err;
        }
        logger.debug(`Failed to enrich PR ${item.externalId}: ${String(err)}`);
      }
    }, 5);
  }

  private getVoteStatus(pr: AdoPullRequest): string {
    if (pr.isDraft) {
      return 'Draft';
    }

    const votes = (pr.reviewers ?? []).map(reviewer => reviewer.vote ?? 0);
    if (votes.some(vote => vote === -10)) {
      return 'Rejected';
    }
    if (votes.some(vote => vote === -5)) {
      return 'Waiting for author';
    }

    const nonZeroVotes = votes.filter(vote => vote !== 0);
    if (nonZeroVotes.length === 0) {
      return 'Waiting on reviews';
    }
    if (nonZeroVotes.every(vote => vote >= 5)) {
      return 'Approved';
    }
    return 'Review in progress';
  }
}

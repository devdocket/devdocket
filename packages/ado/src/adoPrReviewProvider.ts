import { combineSignals, runWorkerPool } from '@devdocket/shared';
import { BaseAdoPrProvider } from './baseAdoPrProvider';
import { OrgConfig } from './configParser';

const GROUP_REVIEWER_CACHE_TTL_MS = 30 * 60 * 1000;

type GraphDescriptorResponse = { value?: string };
type GraphMembershipsResponse = { value?: Array<{ containerDescriptor?: string }> };
type GraphStorageKeyResponse = { value?: string };

type GroupReviewerCacheEntry = {
  expiresAt: number;
  reviewerIds: string[];
};

/**
 * DevDocket provider that discovers Azure DevOps pull requests where the
 * current user is listed as a reviewer.
 */
export class AdoPrReviewProvider extends BaseAdoPrProvider {
  readonly id = 'ado-pr-reviews';
  readonly label = 'Azure DevOps PR Reviews';

  protected readonly searchCriteriaParam = 'reviewerId' as const;
  protected readonly itemReason = 'review_requested';
  protected readonly logLabel = 'PR reviews';

  private readonly cachedGroupReviewerIds = new Map<string, GroupReviewerCacheEntry>();
  private cachedMembershipSessionAccountId: string | undefined;

  constructor(orgConfigs: OrgConfig[]) {
    super(orgConfigs);
  }

  protected override async getAdditionalSearchCriteriaValues(
    token: string,
    org: string,
    userId: string,
    sessionAccountId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (this.cachedMembershipSessionAccountId !== sessionAccountId) {
      this.cachedGroupReviewerIds.clear();
      this.cachedMembershipSessionAccountId = sessionAccountId;
    }

    const cacheKey = `${org}:${userId}`;
    const cached = this.cachedGroupReviewerIds.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.reviewerIds;
    }

    const reviewerIds = await this.resolveGroupReviewerIds(token, org, userId, signal);
    this.cachedGroupReviewerIds.set(cacheKey, {
      reviewerIds,
      expiresAt: now + GROUP_REVIEWER_CACHE_TTL_MS,
    });
    return reviewerIds;
  }

  private async resolveGroupReviewerIds(
    token: string,
    org: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const userDescriptor = await this.fetchUserDescriptor(token, org, userId, signal);
    if (!userDescriptor) {
      return [];
    }

    const groupDescriptors = await this.fetchUpMembershipDescriptors(token, org, userDescriptor, signal);
    if (groupDescriptors.length === 0) {
      return [];
    }

    const groupIds: string[] = [];
    await runWorkerPool(groupDescriptors, async descriptor => {
      const groupId = await this.fetchStorageKey(token, org, descriptor, signal);
      if (groupId && groupId !== userId) {
        groupIds.push(groupId);
      }
    }, 5);
    return [...new Set(groupIds)];
  }

  private async fetchUserDescriptor(
    token: string,
    org: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const url = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/descriptors/${encodeURIComponent(userId)}?api-version=7.1-preview.1`;
    const data = await this.fetchGraphJson<GraphDescriptorResponse>(token, url, `user descriptor for org ${org}`, signal);
    return data?.value;
  }

  private async fetchUpMembershipDescriptors(
    token: string,
    org: string,
    userDescriptor: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const url = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/memberships/${encodeURIComponent(userDescriptor)}?direction=Up&api-version=7.1-preview.1`;
    const data = await this.fetchGraphJson<GraphMembershipsResponse>(token, url, `group memberships for org ${org}`, signal);
    return [...new Set((data?.value ?? []).map(membership => membership.containerDescriptor).filter((descriptor): descriptor is string => Boolean(descriptor)))];
  }

  private async fetchStorageKey(
    token: string,
    org: string,
    descriptor: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const url = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/storageKeys/${encodeURIComponent(descriptor)}?api-version=7.1-preview.1`;
    const data = await this.fetchGraphJson<GraphStorageKeyResponse>(token, url, `storage key for group in org ${org}`, signal);
    return data?.value;
  }

  private async fetchGraphJson<T>(
    token: string,
    url: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: combineSignals(signal, 30_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }
      throw new Error(`Failed to fetch ADO ${label}: ${String(err)}`);
    }

    if (!response?.ok) {
      throw new Error(`Failed to fetch ADO ${label}: ${response?.status ?? 'no response'}`);
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(`Failed to parse ADO ${label}: ${String(err)}`);
    }
  }
}

import type { PRIdentifier, ProviderItem } from '@devdocket/shared';
import type { WorkItem } from '../models/workItem';

/**
 * Provider ids that are known to emit PR work items even when the item
 * itself does not set `itemType: 'pr'`. New PR-emitting providers should
 * be added here so both the sidebar CI badges (`MainViewProvider`) and
 * the CI Watches panel (`WatchPanelProvider`) stay in sync.
 */
const PR_EMITTING_PROVIDER_IDS = new Set([
  'github-my-prs',
  'github-pr-reviews',
  'github-mentions',
  'ado-my-prs',
  'ado-pr-reviews',
]);

/**
 * GitHub PR providers emit `externalId`s as `${owner}/${repo}#${number}`;
 * ADO PR providers emit `${org}/${project}/${repo}/${prId}`. The two
 * forms never collide (3-vs-4 segments, `#`-vs-`/` separator), so callers
 * emit both candidates and let the lookup map decide which one matches.
 */
export function getPRExternalIds(identifier: PRIdentifier): string[] {
  return [`${identifier.repo}#${identifier.prId}`, `${identifier.repo}/${identifier.prId}`];
}

export function isPRWorkItem(
  item: WorkItem,
): item is WorkItem & { providerId: string; externalId: string } {
  return Boolean(
    item.providerId && item.externalId && isPRCandidate(item.providerId, item.itemType),
  );
}

export function isPRProviderItem(providerId: string, item: ProviderItem): boolean {
  return isPRCandidate(providerId, item.itemType);
}

export function isPRCandidate(
  providerId: string,
  itemType: 'issue' | 'pr' | undefined,
): boolean {
  return (
    itemType === 'pr' || (itemType === undefined && PR_EMITTING_PROVIDER_IDS.has(providerId))
  );
}

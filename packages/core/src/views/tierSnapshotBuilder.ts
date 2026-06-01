import type { ProviderItem } from '../api/types';
import { type WorkItem, WorkItemState } from '../models/workItem';
import { buildCanonicalHiddenSet } from '../services/canonicalDedup';
import { resolveGitWorkData } from '../services/gitWorkData';
import type { GitWorkResolverRegistry } from '../services/gitWorkResolverRegistry';
import { getRelatedItemsIndexKey, type RelatedItemsIndex } from '../services/relatedItems';
import { buildProviderBadge, buildProviderBadges, buildTypeBadge } from './badges';
import type { CIBadgeLookup } from './ciBadgeLookup';
import { toItemAuthorData } from './itemAuthorData';
import type { BadgeData, ItemCardData, TierData } from './mainTypes';
import { getProviderItemKey } from './providerItemKey';
import {
  buildProviderItemMap,
  getProviderItemForWorkItem,
  isUrgentProviderItem,
  isUrgentWorkItem,
  sortDoneWorkItems,
  sortPausedWorkItems,
  sortReorderableWorkItems,
} from './sidebarOrdering';

export interface TierSnapshotBuilderOptions {
  allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>;
  getInboxState(providerId: string, externalId: string): string | undefined;
  hasRead(key: string): boolean;
  getProviderLabel(providerId: string): string;
  getItemsByState(...states: WorkItemState[]): WorkItem[];
  findItemByProvenance(providerId: string, externalId: string): WorkItem | undefined;
  relatedItemsIndex: RelatedItemsIndex;
  ciBadgeLookup: CIBadgeLookup;
  gitWorkResolverRegistry?: GitWorkResolverRegistry;
}

export interface IncomingCardDataOptions {
  relatedItemsIndex: RelatedItemsIndex;
  existingWorkItem?: WorkItem;
  ciBadgeLookup: CIBadgeLookup;
  hasRead(key: string): boolean;
  getProviderLabel(providerId: string): string;
}

export interface WorkItemCardDataOptions {
  tierType: ItemCardData['tierType'];
  providerItemMap: ReadonlyMap<string, ProviderItem>;
  relatedItemsIndex: RelatedItemsIndex;
  ciBadgeLookup: CIBadgeLookup;
  getProviderLabel(providerId: string): string;
  gitWorkResolverRegistry?: GitWorkResolverRegistry;
}

export function buildTierData(options: TierSnapshotBuilderOptions): TierData[] {
  const hiddenCanonicalKeys = buildCanonicalHiddenSet(
    options.allProviderItems,
    (providerId, externalId) => options.getInboxState(providerId, externalId),
  );
  const providerItemMap = buildProviderItemMap(options.allProviderItems);

  const incomingItems: ItemCardData[] = [];
  for (const [providerId, items] of options.allProviderItems) {
    for (const providerItem of items) {
      const inboxState = options.getInboxState(providerId, providerItem.externalId);
      if (inboxState !== undefined && inboxState !== 'unseen') {
        continue;
      }

      const key = getProviderItemKey(providerId, providerItem.externalId);
      if (hiddenCanonicalKeys.has(key)) {
        continue;
      }

      incomingItems.push(
        buildIncomingCardData(providerId, providerItem, {
          relatedItemsIndex: options.relatedItemsIndex,
          existingWorkItem: options.findItemByProvenance(providerId, providerItem.externalId),
          ciBadgeLookup: options.ciBadgeLookup,
          hasRead: options.hasRead,
          getProviderLabel: options.getProviderLabel,
        }),
      );
    }
  }
  incomingItems.reverse();

  const inProgressItems = sortReorderableWorkItems(
    options.getItemsByState(WorkItemState.InProgress),
    providerItemMap,
  ).map(item => buildWorkItemCardData(item, {
    tierType: 'inProgress',
    providerItemMap,
    relatedItemsIndex: options.relatedItemsIndex,
    ciBadgeLookup: options.ciBadgeLookup,
    getProviderLabel: options.getProviderLabel,
    gitWorkResolverRegistry: options.gitWorkResolverRegistry,
  }));

  const readyToStartItems = sortReorderableWorkItems(
    options.getItemsByState(WorkItemState.New),
    providerItemMap,
  ).map(item => buildWorkItemCardData(item, {
    tierType: 'readyToStart',
    providerItemMap,
    relatedItemsIndex: options.relatedItemsIndex,
    ciBadgeLookup: options.ciBadgeLookup,
    getProviderLabel: options.getProviderLabel,
    gitWorkResolverRegistry: options.gitWorkResolverRegistry,
  }));

  const pausedItems = sortPausedWorkItems(options.getItemsByState(WorkItemState.Paused))
    .map(item => buildWorkItemCardData(item, {
      tierType: 'paused',
      providerItemMap,
      relatedItemsIndex: options.relatedItemsIndex,
      ciBadgeLookup: options.ciBadgeLookup,
      getProviderLabel: options.getProviderLabel,
      gitWorkResolverRegistry: options.gitWorkResolverRegistry,
    }));

  const doneItems = sortDoneWorkItems(options.getItemsByState(WorkItemState.Done, WorkItemState.Archived))
    .map(item => buildWorkItemCardData(item, {
      tierType: 'done',
      providerItemMap,
      relatedItemsIndex: options.relatedItemsIndex,
      ciBadgeLookup: options.ciBadgeLookup,
      getProviderLabel: options.getProviderLabel,
      gitWorkResolverRegistry: options.gitWorkResolverRegistry,
    }));

  return [
    { id: 'incoming', name: 'Incoming', icon: '↓', items: incomingItems, collapsed: false },
    { id: 'in-progress', name: 'In Progress', icon: '▶', items: inProgressItems, collapsed: false },
    { id: 'ready-to-start', name: 'Ready to Start', icon: '○', items: readyToStartItems, collapsed: false },
    { id: 'paused', name: 'Paused', icon: '⏸', items: pausedItems, collapsed: false },
    { id: 'done', name: 'Done', icon: '✓', items: doneItems, collapsed: true },
  ].filter(tier => tier.items.length > 0);
}

export function buildIncomingCardData(
  providerId: string,
  providerItem: ProviderItem,
  options: IncomingCardDataOptions,
): ItemCardData {
  const key = getProviderItemKey(providerId, providerItem.externalId);
  return {
    id: options.existingWorkItem?.id ?? key,
    title: providerItem.title,
    badges: buildSidebarBadges(providerId, providerItem, options.ciBadgeLookup.byProviderItemKey.get(key), options.getProviderLabel),
    url: providerItem.url,
    repoAnnotation: providerItem.group ?? options.existingWorkItem?.group,
    author: toItemAuthorData(providerItem),
    authored: providerItem.authored,
    tierType: 'incoming',
    isUnseen: !options.hasRead(key),
    isUrgent: isUrgentProviderItem(providerItem),
    hasRelatedItems: hasResolvedRelatedItems(providerId, providerItem.externalId, options.relatedItemsIndex),
    providerId,
    externalId: providerItem.externalId,
  };
}

export function buildWorkItemCardData(
  item: WorkItem,
  options: WorkItemCardDataOptions,
): ItemCardData {
  const providerItem = getProviderItemForWorkItem(item, options.providerItemMap);
  return {
    id: item.id,
    title: item.title,
    badges: buildSidebarBadges(item.providerId, providerItem, options.ciBadgeLookup.byWorkItemId.get(item.id), options.getProviderLabel),
    url: providerItem?.url ?? item.url,
    repoAnnotation: item.group ?? providerItem?.group,
    author: toItemAuthorData(providerItem),
    authored: providerItem?.authored,
    tierType: options.tierType,
    isUrgent: isUrgentWorkItem(item, options.providerItemMap),
    hasRelatedItems: item.providerId && item.externalId
      ? hasResolvedRelatedItems(item.providerId, item.externalId, options.relatedItemsIndex)
      : false,
    gitWork: resolveGitWorkData(options.gitWorkResolverRegistry, item),
    providerId: item.providerId,
    externalId: item.externalId,
  };
}

export function buildAcceptPayload(providerId: string, providerItem: ProviderItem): Record<string, unknown> {
  return {
    kind: 'item',
    providerId,
    externalId: providerItem.externalId,
    title: providerItem.title,
    description: providerItem.description,
    url: providerItem.url,
    ...(providerItem.itemType ? { itemType: providerItem.itemType } : {}),
    ...(providerItem.group ? { group: providerItem.group } : {}),
    ...(providerItem.canonicalId ? { canonicalId: providerItem.canonicalId } : {}),
  };
}

export function buildSidebarBadges(
  providerId: string | undefined,
  providerItem: ProviderItem | undefined,
  ciBadge: BadgeData | undefined,
  getProviderLabel: (providerId: string) => string,
): BadgeData[] {
  const badges: BadgeData[] = [];
  const providerLabel = providerId ? getProviderLabel(providerId) : undefined;
  const providerBadge = buildProviderBadge(providerId, providerLabel);
  if (providerBadge) {
    badges.push(providerBadge);
  }

  const typeBadge = buildTypeBadge(providerItem);
  if (typeBadge) {
    badges.push(typeBadge);
  }

  badges.push(...buildProviderBadges(providerItem, 'sidebar'));

  if (ciBadge) {
    badges.push(ciBadge);
  }

  return badges;
}

export function hasResolvedRelatedItems(
  providerId: string,
  externalId: string,
  relatedItemsIndex: RelatedItemsIndex,
): boolean {
  return (relatedItemsIndex.get(getRelatedItemsIndexKey(providerId, externalId))?.length ?? 0) > 0;
}

import type { DiscoveredItem, RelatedItemRef } from '../api/types';
import type { WorkItem } from '../models/workItem';
import type { ResolvedRelatedItem } from '../views/relatedItemTypes';
import type { ProviderRegistry } from './providerRegistry';
import type { WorkGraph } from './workGraph';
import { logger } from './logger';

export type RelatedItemsIndex = Map<string, ResolvedRelatedItem[]>;

interface ResolvedRelatedItemWithSort extends ResolvedRelatedItem {
  externalId: string;
}

interface DiscoveredMatch {
  providerId: string;
  externalId: string;
  itemType: RelatedItemRef['itemType'];
  title?: string;
}

type ResolvableItem = Pick<WorkItem, 'providerId' | 'externalId'> & { itemType?: RelatedItemRef['itemType'] };

export function resolveRelatedItemsFor(
  item: ResolvableItem,
  registry: ProviderRegistry,
  workGraph: WorkGraph,
  relatedItemsIndex?: RelatedItemsIndex,
): ResolvedRelatedItem[] {
  if (!item.providerId || !item.externalId) {
    return [];
  }

  const indexKey = getRelatedItemsIndexKey(item.providerId, item.externalId);
  const precomputed = relatedItemsIndex?.get(indexKey);
  if (precomputed) {
    return precomputed;
  }

  const discoveredItems = registry.getAllDiscoveredItems();
  const indexed = relatedItemsIndex ? undefined : buildRelatedItemsIndexForDiscovered(discoveredItems, workGraph).get(indexKey);
  if (indexed) {
    return indexed;
  }

  const currentDiscovered = findDiscoveredItem(discoveredItems, item.providerId, item.externalId);
  const currentItemType = item.itemType ?? currentDiscovered?.itemType;
  if (!currentDiscovered && isRelatedItemType(currentItemType)) {
    return resolveReverseRefsForUndiscovered(item.providerId, item.externalId, currentItemType, discoveredItems, workGraph);
  }
  return [];
}

export function buildRelatedItemsIndex(
  registry: ProviderRegistry,
  workGraph: WorkGraph,
  discoveredItems: Map<string, DiscoveredItem[]> = registry.getAllDiscoveredItems(),
): RelatedItemsIndex {
  return buildRelatedItemsIndexForDiscovered(discoveredItems, workGraph);
}

function buildRelatedItemsIndexForDiscovered(
  discoveredItems: Map<string, DiscoveredItem[]>,
  workGraph: WorkGraph,
): RelatedItemsIndex {
  const discoveredByRef = buildDiscoveredByRef(discoveredItems, workGraph);
  const workingIndex = new Map<string, Map<string, ResolvedRelatedItemWithSort>>();
  let totalRefCount = 0;
  let resolvedRefCount = 0;
  let droppedRefCount = 0;

  for (const [providerId, items] of discoveredItems) {
    for (const item of items) {
      const relatedItems = item.relatedItems ?? [];
      if (relatedItems.length === 0) {
        continue;
      }

      const resolved = getOrCreateResolvedSet(workingIndex, providerId, item.externalId);
      for (const ref of relatedItems) {
        totalRefCount++;
        const target = resolveRef(ref, discoveredByRef, workGraph);
        if (target) {
          resolvedRefCount++;
          upsertResolved(resolved, target);
        } else {
          droppedRefCount++;
        }
      }
    }
  }

  for (const [providerId, items] of discoveredItems) {
    for (const candidate of items) {
      if (candidate.itemType !== 'pr' || !candidate.relatedItems?.length) {
        continue;
      }

      for (const ref of candidate.relatedItems) {
        const target = resolveDiscoveredTarget(providerId, candidate.externalId, candidate.itemType, ref.relation, workGraph, 'reverse', candidate.title);
        if (!target) {
          continue;
        }

        for (const match of discoveredByRef.get(getRefKey(ref.itemType, ref.externalId)) ?? []) {
          if (match.providerId === providerId && match.externalId === candidate.externalId) {
            continue;
          }
          upsertResolved(getOrCreateResolvedSet(workingIndex, match.providerId, match.externalId), target);
        }
      }
    }
  }

  if (totalRefCount > 0) {
    logger.debug(`Resolved ${resolvedRefCount} / ${totalRefCount} related-item refs (${droppedRefCount} dropped because target not in DevDocket)`);
  }

  const publicIndex: RelatedItemsIndex = new Map();
  for (const [key, resolved] of workingIndex) {
    const relatedItems = toPublicResolvedItems(resolved);
    if (relatedItems.length > 0) {
      publicIndex.set(key, relatedItems);
    }
  }
  return publicIndex;
}

function resolveReverseRefsForUndiscovered(
  providerId: string,
  externalId: string,
  itemType: RelatedItemRef['itemType'],
  discoveredItems: Map<string, DiscoveredItem[]>,
  workGraph: WorkGraph,
): ResolvedRelatedItem[] {
  const resolved = new Map<string, ResolvedRelatedItemWithSort>();
  for (const [candidateProviderId, items] of discoveredItems) {
    for (const candidate of items) {
      if (candidate.itemType !== 'pr' || !candidate.relatedItems?.length) {
        continue;
      }
      if (candidateProviderId === providerId && candidate.externalId === externalId) {
        continue;
      }

      for (const ref of candidate.relatedItems) {
        if (ref.externalId !== externalId || ref.itemType !== itemType) {
          continue;
        }

        const target = resolveDiscoveredTarget(
          candidateProviderId,
          candidate.externalId,
          candidate.itemType,
          ref.relation,
          workGraph,
          'reverse',
          candidate.title,
        );
        if (target) {
          upsertResolved(resolved, target);
        }
      }
    }
  }
  return toPublicResolvedItems(resolved);
}

function buildDiscoveredByRef(discoveredItems: Map<string, DiscoveredItem[]>, workGraph: WorkGraph): Map<string, DiscoveredMatch[]> {
  const discoveredByRef = new Map<string, DiscoveredMatch[]>();
  const discoveredProvenance = new Set<string>();
  for (const [providerId, items] of discoveredItems) {
    for (const item of items) {
      discoveredProvenance.add(getProvenanceKey(providerId, item.externalId));
      addPotentialTargetMatch(discoveredByRef, item.itemType, providerId, item.externalId, item.title);
    }
  }
  for (const item of workGraph.getAll()) {
    if (item.providerId && item.externalId && !discoveredProvenance.has(getProvenanceKey(item.providerId, item.externalId))) {
      addPotentialTargetMatch(discoveredByRef, item.itemType, item.providerId, item.externalId, item.title);
    }
  }
  return discoveredByRef;
}

function getProvenanceKey(providerId: string, externalId: string): string {
  return `${providerId}\0${externalId}`;
}

function addPotentialTargetMatch(
  discoveredByRef: Map<string, DiscoveredMatch[]>,
  itemType: RelatedItemRef['itemType'] | undefined,
  providerId: string,
  externalId: string,
  title?: string,
): void {
  if (isRelatedItemType(itemType)) {
    addDiscoveredMatch(discoveredByRef, itemType, providerId, externalId, title);
  } else {
    addDiscoveredMatch(discoveredByRef, 'issue', providerId, externalId, title);
    addDiscoveredMatch(discoveredByRef, 'pr', providerId, externalId, title);
  }
}

function addDiscoveredMatch(
  discoveredByRef: Map<string, DiscoveredMatch[]>,
  itemType: RelatedItemRef['itemType'],
  providerId: string,
  externalId: string,
  title?: string,
): void {
  const key = getRefKey(itemType, externalId);
  const matches = discoveredByRef.get(key) ?? [];
  matches.push({ providerId, externalId, itemType, title });
  discoveredByRef.set(key, matches);
}

function getOrCreateResolvedSet(
  index: Map<string, Map<string, ResolvedRelatedItemWithSort>>,
  providerId: string,
  externalId: string,
): Map<string, ResolvedRelatedItemWithSort> {
  const key = getRelatedItemsIndexKey(providerId, externalId);
  const existing = index.get(key);
  if (existing) {
    return existing;
  }
  const resolved = new Map<string, ResolvedRelatedItemWithSort>();
  index.set(key, resolved);
  return resolved;
}

function findDiscoveredItem(
  discoveredItems: Map<string, DiscoveredItem[]>,
  providerId: string,
  externalId: string,
): DiscoveredItem | undefined {
  return discoveredItems.get(providerId)?.find(discovered => discovered.externalId === externalId);
}

function resolveRef(
  ref: RelatedItemRef,
  discoveredByRef: Map<string, DiscoveredMatch[]>,
  workGraph: WorkGraph,
): ResolvedRelatedItemWithSort | undefined {
  let fallback: ResolvedRelatedItemWithSort | undefined;
  for (const match of discoveredByRef.get(getRefKey(ref.itemType, ref.externalId)) ?? []) {
    const target = resolveDiscoveredTarget(match.providerId, match.externalId, match.itemType, ref.relation, workGraph, 'forward', match.title);
    if (!target) {
      continue;
    }
    if (target.targetKind === 'workItem') {
      return target;
    }
    fallback ??= target;
  }
  return fallback;
}

function resolveDiscoveredTarget(
  providerId: string,
  externalId: string,
  itemType: RelatedItemRef['itemType'] | undefined,
  relation: RelatedItemRef['relation'],
  workGraph: WorkGraph,
  direction: 'forward' | 'reverse' = 'forward',
  fallbackTitle?: string,
): ResolvedRelatedItemWithSort | undefined {
  if (!isRelatedItemType(itemType)) {
    return undefined;
  }

  const workItem = workGraph.findItemByProvenance(providerId, externalId);
  return {
    targetItemId: workItem?.id ?? getSourcesTargetId(providerId, externalId),
    targetTitle: workItem?.title ?? fallbackTitle ?? externalId,
    targetExternalId: externalId,
    targetKind: workItem ? 'workItem' : 'sources',
    ...(!workItem ? { targetProviderId: providerId } : {}),
    label: getRelatedItemLabel(relation, externalId, direction),
    relation,
    itemType,
    externalId,
  };
}

function getSourcesTargetId(providerId: string, externalId: string): string {
  return `sources:${JSON.stringify([providerId, externalId])}`;
}

function getRelatedItemLabel(
  relation: RelatedItemRef['relation'],
  externalId: string,
  direction: 'forward' | 'reverse',
): string {
  if (relation === 'linked') {
    return `Linked to ${externalId}`;
  }
  return direction === 'reverse' ? `Closed by ${externalId}` : `Closes ${externalId}`;
}

function upsertResolved(
  resolved: Map<string, ResolvedRelatedItemWithSort>,
  item: ResolvedRelatedItemWithSort,
): void {
  const key = `${item.itemType}\0${item.externalId}`;
  const existing = resolved.get(key);
  if (!existing || isPreferredResolvedItem(item, existing)) {
    resolved.set(key, item);
  }
}

function isPreferredResolvedItem(
  candidate: ResolvedRelatedItemWithSort,
  existing: ResolvedRelatedItemWithSort,
): boolean {
  if (candidate.targetKind !== existing.targetKind) {
    return candidate.targetKind === 'workItem';
  }
  return existing.relation === 'linked' && candidate.relation === 'closes';
}

function toPublicResolvedItems(resolved: Map<string, ResolvedRelatedItemWithSort>): ResolvedRelatedItem[] {
  return Array.from(resolved.values())
    .sort(compareResolvedItems)
    .map(({ externalId: _externalId, ...publicItem }) => publicItem);
}

function compareResolvedItems(left: ResolvedRelatedItemWithSort, right: ResolvedRelatedItemWithSort): number {
  const relationOrder = relationRank(left.relation) - relationRank(right.relation);
  if (relationOrder !== 0) {
    return relationOrder;
  }

  const leftParts = parseExternalId(left.externalId);
  const rightParts = parseExternalId(right.externalId);
  return leftParts.owner.localeCompare(rightParts.owner)
    || leftParts.repo.localeCompare(rightParts.repo)
    || leftParts.number - rightParts.number
    || left.externalId.localeCompare(right.externalId);
}

function relationRank(relation: RelatedItemRef['relation']): number {
  return relation === 'closes' ? 0 : 1;
}

export function getRelatedItemsIndexKey(providerId: string, externalId: string): string {
  return JSON.stringify([providerId, externalId]);
}

function getRefKey(itemType: RelatedItemRef['itemType'], externalId: string): string {
  return `${itemType}\0${externalId}`;
}

function isRelatedItemType(itemType: RelatedItemRef['itemType'] | undefined): itemType is RelatedItemRef['itemType'] {
  return itemType === 'issue' || itemType === 'pr';
}

function parseExternalId(externalId: string): { owner: string; repo: string; number: number } {
  const match = externalId.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    return { owner: externalId, repo: '', number: Number.MAX_SAFE_INTEGER };
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

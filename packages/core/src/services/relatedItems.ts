import type { DiscoveredItem, RelatedItemRef } from '../api/types';
import type { WorkItem } from '../models/workItem';
import type { ProviderRegistry } from './providerRegistry';
import type { WorkGraph } from './workGraph';

export interface ResolvedRelatedItem {
  /** The work item id, or `${providerId}::${externalId}` for Sources entries. */
  targetItemId: string;
  label: string;
  targetKind: 'workItem' | 'sources';
  relation: RelatedItemRef['relation'];
  itemType: RelatedItemRef['itemType'];
}

interface ResolvedRelatedItemWithSort extends ResolvedRelatedItem {
  externalId: string;
}

type ResolvableItem = Pick<WorkItem, 'providerId' | 'externalId'> & { itemType?: RelatedItemRef['itemType'] };

export function resolveRelatedItemsFor(
  item: ResolvableItem,
  registry: ProviderRegistry,
  workGraph: WorkGraph,
): ResolvedRelatedItem[] {
  if (!item.providerId || !item.externalId) {
    return [];
  }

  const discoveredItems = registry.getAllDiscoveredItems();
  const currentDiscovered = findDiscoveredItem(discoveredItems, item.providerId, item.externalId);
  const currentItemType = item.itemType ?? currentDiscovered?.itemType;
  if (currentItemType !== 'issue' && currentItemType !== 'pr') {
    return [];
  }

  const resolved = new Map<string, ResolvedRelatedItemWithSort>();

  for (const ref of currentDiscovered?.relatedItems ?? []) {
    const target = resolveRef(ref, discoveredItems, workGraph);
    if (target) {
      upsertResolved(resolved, target);
    }
  }

  for (const [providerId, items] of discoveredItems) {
    for (const candidate of items) {
      if (candidate.itemType !== 'pr' || !candidate.relatedItems?.length) {
        continue;
      }
      if (providerId === item.providerId && candidate.externalId === item.externalId) {
        continue;
      }

      for (const ref of candidate.relatedItems) {
        if (ref.externalId !== item.externalId || ref.itemType !== currentItemType) {
          continue;
        }

        const target = resolveDiscoveredTarget(
          providerId,
          candidate.externalId,
          candidate.itemType,
          ref.relation,
          workGraph,
        );
        if (target) {
          upsertResolved(resolved, target);
        }
      }
    }
  }

  return Array.from(resolved.values())
    .sort(compareResolvedItems)
    .map(({ externalId: _externalId, ...publicItem }) => publicItem);
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
  discoveredItems: Map<string, DiscoveredItem[]>,
  workGraph: WorkGraph,
): ResolvedRelatedItemWithSort | undefined {
  let fallback: ResolvedRelatedItemWithSort | undefined;
  for (const [providerId, items] of discoveredItems) {
    const match = items.find(candidate => candidate.externalId === ref.externalId && candidate.itemType === ref.itemType);
    if (!match) {
      continue;
    }

    const target = resolveDiscoveredTarget(providerId, match.externalId, ref.itemType, ref.relation, workGraph);
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
): ResolvedRelatedItemWithSort | undefined {
  if (itemType !== 'issue' && itemType !== 'pr') {
    return undefined;
  }

  const workItem = workGraph.findItemByProvenance(providerId, externalId);
  return {
    targetItemId: workItem?.id ?? `${providerId}::${externalId}`,
    targetKind: workItem ? 'workItem' : 'sources',
    label: relation === 'closes' ? `Closes ${externalId}` : `Linked to ${externalId}`,
    relation,
    itemType,
    externalId,
  };
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

function parseExternalId(externalId: string): { owner: string; repo: string; number: number } {
  const match = externalId.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    return { owner: externalId, repo: '', number: Number.MAX_SAFE_INTEGER };
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

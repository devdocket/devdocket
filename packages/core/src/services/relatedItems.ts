import type { ProviderItem, RelatedItemRef } from '../api/types';
import type { WorkItem } from '../models/workItem';
import type { ResolvedRelatedItem } from '../views/relatedItemTypes';
import type { ProviderRegistry } from './providerRegistry';
import type { WorkGraph } from './workGraph';
import { logger } from './logger';

/** Cached related-item lookup. Treat the map and arrays as immutable. */
export type RelatedItemsIndex = Map<string, ResolvedRelatedItem[]>;

interface RelatedItemsIndexSignature {
  value: string;
  hasAnyRelatedItems: boolean;
  hasPrRelatedItems: boolean;
}

interface RelatedItemsIndexCacheEntry {
  signature: string;
  index: RelatedItemsIndex;
}

let relatedItemsIndexCache = new WeakMap<WorkGraph, RelatedItemsIndexCacheEntry>();

interface ResolvedRelatedItemWithSort extends ResolvedRelatedItem {
  externalId: string;
}

interface ProviderItemMatch {
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

  const providerItems = registry.getAllProviderItems();
  const indexed = relatedItemsIndex ? undefined : buildRelatedItemsIndexForDiscovered(providerItems, workGraph).get(indexKey);
  if (indexed) {
    return indexed;
  }

  const currentProviderItem = findProviderItem(providerItems, item.providerId, item.externalId);
  const currentItemType = item.itemType ?? currentProviderItem?.itemType;
  if (!currentProviderItem && isRelatedItemType(currentItemType)) {
    return resolveReverseRefsForUndiscovered(item.providerId, item.externalId, currentItemType, providerItems, workGraph);
  }
  return [];
}

export function buildRelatedItemsIndex(
  registry: ProviderRegistry,
  workGraph: WorkGraph,
  providerItems: Map<string, ProviderItem[]> = registry.getAllProviderItems(),
): RelatedItemsIndex {
  return buildRelatedItemsIndexForDiscovered(providerItems, workGraph);
}

function buildRelatedItemsIndexForDiscovered(
  providerItems: Map<string, ProviderItem[]>,
  workGraph: WorkGraph,
): RelatedItemsIndex {
  const signature = getRelatedItemsIndexSignature(providerItems, workGraph);
  const cached = relatedItemsIndexCache.get(workGraph);
  if (cached?.signature === signature.value) {
    return cached.index;
  }

  if (!signature.hasAnyRelatedItems) {
    const emptyIndex: RelatedItemsIndex = new Map();
    relatedItemsIndexCache.set(workGraph, { signature: signature.value, index: emptyIndex });
    return emptyIndex;
  }

  const providerItemsByRef = buildProviderItemsByRef(providerItems, workGraph);
  const workingIndex = new Map<string, Map<string, ResolvedRelatedItemWithSort>>();
  let totalRefCount = 0;
  let resolvedRefCount = 0;
  let droppedRefCount = 0;

  for (const [providerId, items] of providerItems) {
    for (const item of items) {
      const relatedItems = item.relatedItems ?? [];
      if (relatedItems.length === 0) {
        continue;
      }

      const resolved = getOrCreateResolvedSet(workingIndex, providerId, item.externalId);
      for (const ref of relatedItems) {
        totalRefCount++;
        const target = resolveRef(ref, providerItemsByRef, workGraph);
        if (target) {
          resolvedRefCount++;
          upsertResolved(resolved, target);
        } else {
          droppedRefCount++;
        }
      }
    }
  }

  if (signature.hasPrRelatedItems) {
    for (const [providerId, items] of providerItems) {
      for (const candidate of items) {
        if (candidate.itemType !== 'pr' || !candidate.relatedItems?.length) {
          continue;
        }

        for (const ref of candidate.relatedItems) {
          const target = resolveProviderItemTarget(providerId, candidate.externalId, candidate.itemType, ref.relation, workGraph, 'reverse', candidate.title);
          if (!target) {
            continue;
          }

          for (const match of providerItemsByRef.get(getRefKey(ref.itemType, ref.externalId)) ?? []) {
            if (match.providerId === providerId && match.externalId === candidate.externalId) {
              continue;
            }
            upsertResolved(getOrCreateResolvedSet(workingIndex, match.providerId, match.externalId), target);
          }
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
  relatedItemsIndexCache.set(workGraph, { signature: signature.value, index: publicIndex });
  return publicIndex;
}

export function clearRelatedItemsIndexCacheForTests(): void {
  relatedItemsIndexCache = new WeakMap<WorkGraph, RelatedItemsIndexCacheEntry>();
}

function getRelatedItemsIndexSignature(providerItems: Map<string, ProviderItem[]>, workGraph: WorkGraph): RelatedItemsIndexSignature {
  let hash = 2166136261;
  let itemCount = 0;
  let refCount = 0;
  let hasAnyRelatedItems = false;
  let hasPrRelatedItems = false;

  for (const [providerId, items] of providerItems) {
    hash = appendHashPart(hash, providerId);
    hash = appendHashPart(hash, items.length);
    for (const item of items) {
      itemCount++;
      const relatedItems = item.relatedItems ?? [];
      hash = appendHashPart(hash, item.externalId);
      hash = appendHashPart(hash, item.itemType);
      hash = appendHashPart(hash, item.version);
      hash = appendHashPart(hash, item.resurfaceVersion);
      hash = appendHashPart(hash, item.title);
      hash = appendHashPart(hash, relatedItems.length);

      if (relatedItems.length > 0) {
        hasAnyRelatedItems = true;
        hasPrRelatedItems ||= item.itemType === 'pr';
      }

      for (const ref of relatedItems) {
        refCount++;
        hash = appendHashPart(hash, ref.externalId);
        hash = appendHashPart(hash, ref.itemType);
        hash = appendHashPart(hash, ref.relation);
      }
    }
  }

  const workGraphSignature = getWorkGraphSignature(workGraph);
  return {
    value: `${itemCount}:${refCount}:${hasPrRelatedItems ? 1 : 0}:${hash.toString(36)}:${workGraphSignature}`,
    hasAnyRelatedItems,
    hasPrRelatedItems,
  };
}

function getWorkGraphSignature(workGraph: WorkGraph): string {
  const getRelatedItemsVersion = (workGraph as Partial<Pick<WorkGraph, 'getRelatedItemsVersion'>>).getRelatedItemsVersion;
  const relatedItemsVersion = getRelatedItemsVersion?.call(workGraph);
  if (relatedItemsVersion !== undefined) {
    return `v:${relatedItemsVersion}`;
  }

  let hash = 2166136261;
  let provenanceCount = 0;
  for (const item of workGraph.getAll()) {
    if (!item.providerId || !item.externalId) {
      continue;
    }
    provenanceCount++;
    hash = appendHashPart(hash, item.id);
    hash = appendHashPart(hash, item.providerId);
    hash = appendHashPart(hash, item.externalId);
    hash = appendHashPart(hash, item.itemType);
    hash = appendHashPart(hash, item.title);
  }
  return `h:${provenanceCount}:${hash.toString(36)}`;
}

function appendHashPart(hash: number, value: unknown): number {
  const text = value === undefined ? '<undefined>' : String(value);
  hash = appendHashText(hash, String(text.length));
  hash = appendHashText(hash, ':');
  hash = appendHashText(hash, text);
  return appendHashText(hash, ';');
}

function appendHashText(hash: number, text: string): number {
  let next = hash;
  for (let index = 0; index < text.length; index++) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, 16777619) >>> 0;
  }
  return next;
}

function resolveReverseRefsForUndiscovered(
  providerId: string,
  externalId: string,
  itemType: RelatedItemRef['itemType'],
  providerItems: Map<string, ProviderItem[]>,
  workGraph: WorkGraph,
): ResolvedRelatedItem[] {
  const resolved = new Map<string, ResolvedRelatedItemWithSort>();
  for (const [candidateProviderId, items] of providerItems) {
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

        const target = resolveProviderItemTarget(
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

function buildProviderItemsByRef(providerItems: Map<string, ProviderItem[]>, workGraph: WorkGraph): Map<string, ProviderItemMatch[]> {
  const providerItemsByRef = new Map<string, ProviderItemMatch[]>();
  const discoveredProvenance = new Set<string>();
  for (const [providerId, items] of providerItems) {
    for (const item of items) {
      discoveredProvenance.add(getProvenanceKey(providerId, item.externalId));
      addPotentialTargetMatch(providerItemsByRef, item.itemType, providerId, item.externalId, item.title);
    }
  }
  for (const item of workGraph.getAll()) {
    if (item.providerId && item.externalId && !discoveredProvenance.has(getProvenanceKey(item.providerId, item.externalId))) {
      addPotentialTargetMatch(providerItemsByRef, item.itemType, item.providerId, item.externalId, item.title);
    }
  }
  return providerItemsByRef;
}

function getProvenanceKey(providerId: string, externalId: string): string {
  return `${providerId}\0${externalId}`;
}

function addPotentialTargetMatch(
  providerItemsByRef: Map<string, ProviderItemMatch[]>,
  itemType: RelatedItemRef['itemType'] | undefined,
  providerId: string,
  externalId: string,
  title?: string,
): void {
  if (isRelatedItemType(itemType)) {
    addProviderItemMatch(providerItemsByRef, itemType, providerId, externalId, title);
  } else {
    addProviderItemMatch(providerItemsByRef, 'issue', providerId, externalId, title);
    addProviderItemMatch(providerItemsByRef, 'pr', providerId, externalId, title);
  }
}

function addProviderItemMatch(
  providerItemsByRef: Map<string, ProviderItemMatch[]>,
  itemType: RelatedItemRef['itemType'],
  providerId: string,
  externalId: string,
  title?: string,
): void {
  const key = getRefKey(itemType, externalId);
  const matches = providerItemsByRef.get(key) ?? [];
  matches.push({ providerId, externalId, itemType, title });
  providerItemsByRef.set(key, matches);
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

function findProviderItem(
  providerItems: Map<string, ProviderItem[]>,
  providerId: string,
  externalId: string,
): ProviderItem | undefined {
  return providerItems.get(providerId)?.find(item => item.externalId === externalId);
}

function resolveRef(
  ref: RelatedItemRef,
  providerItemsByRef: Map<string, ProviderItemMatch[]>,
  workGraph: WorkGraph,
): ResolvedRelatedItemWithSort | undefined {
  let fallback: ResolvedRelatedItemWithSort | undefined;
  for (const match of providerItemsByRef.get(getRefKey(ref.itemType, ref.externalId)) ?? []) {
    const target = resolveProviderItemTarget(match.providerId, match.externalId, match.itemType, ref.relation, workGraph, 'forward', match.title);
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

function resolveProviderItemTarget(
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
  const targetTitle = workItem?.title ?? fallbackTitle ?? externalId;
  return {
    targetItemId: workItem?.id ?? getSourcesTargetId(providerId, externalId),
    targetTitle,
    targetExternalId: externalId,
    targetKind: workItem ? 'workItem' : 'sources',
    ...(!workItem ? { targetProviderId: providerId } : {}),
    label: getRelatedItemLabel(relation, targetTitle, direction),
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
  title: string,
  direction: 'forward' | 'reverse',
): string {
  if (relation === 'linked') {
    return `Linked to ${title}`;
  }
  return direction === 'reverse' ? `Closed by ${title}` : `Closes ${title}`;
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

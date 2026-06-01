import type { ProviderItem } from '../api/types';
import { type WorkItem, WorkItemState } from '../models/workItem';
import { getProviderItemKey } from './providerItemKey';

export function buildProviderItemMap(allProviderItems: Iterable<[string, readonly ProviderItem[]]>): Map<string, ProviderItem> {
  const providerItemMap = new Map<string, ProviderItem>();
  for (const [providerId, items] of allProviderItems) {
    for (const item of items) {
      providerItemMap.set(getProviderItemKey(providerId, item.externalId), item);
    }
  }
  return providerItemMap;
}

export function getProviderItemForWorkItem(
  item: WorkItem,
  providerItemMap: ReadonlyMap<string, ProviderItem>,
): ProviderItem | undefined {
  if (!item.providerId || !item.externalId) {
    return undefined;
  }
  return providerItemMap.get(getProviderItemKey(item.providerId, item.externalId));
}

export function compareWorkItemUrgency(
  a: WorkItem,
  b: WorkItem,
  providerItemMap: ReadonlyMap<string, ProviderItem>,
): number {
  const aUrgent = isUrgentWorkItem(a, providerItemMap);
  const bUrgent = isUrgentWorkItem(b, providerItemMap);
  if (aUrgent === bUrgent) {
    return 0;
  }
  return aUrgent ? -1 : 1;
}

export function isUrgentWorkItem(item: WorkItem, providerItemMap: ReadonlyMap<string, ProviderItem>): boolean {
  return isUrgentProviderItem(getProviderItemForWorkItem(item, providerItemMap));
}

export function isUrgentProviderItem(providerItem?: ProviderItem): boolean {
  return normalizeText(providerItem?.state) === 'changes requested';
}

export function sortReorderableWorkItems(
  items: WorkItem[],
  providerItemMap: ReadonlyMap<string, ProviderItem>,
): WorkItem[] {
  return items.sort((a, b) => compareWorkItemUrgency(a, b, providerItemMap)
    || compareManualOrderThenUpdated(a, b));
}

export function sortPausedWorkItems(items: WorkItem[]): WorkItem[] {
  return items.sort((a, b) => a.updatedAt - b.updatedAt);
}

export function sortDoneWorkItems(items: WorkItem[]): WorkItem[] {
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sortReorderBaselineItems(items: WorkItem[]): WorkItem[] {
  return items.sort(compareManualOrderThenUpdated);
}

export function isReorderableState(state: WorkItemState): state is WorkItemState.New | WorkItemState.InProgress {
  return state === WorkItemState.New || state === WorkItemState.InProgress;
}

function compareManualOrderThenUpdated(a: WorkItem, b: WorkItem): number {
  return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
    || b.updatedAt - a.updatedAt;
}

function normalizeText(value?: string): string {
  return value?.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') ?? '';
}

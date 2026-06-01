import type { ProviderItem } from '../api/types';
import type { WorkItem } from '../models/workItem';
import { isFailedConclusion } from '../webview/shared/runConclusionLabels';
import { getPRExternalIds, isPRProviderItem, isPRWorkItem } from './prHelpers';
import { getProviderItemKey } from './providerItemKey';
import type { WatcherService, WatchedRun } from '../services/watcherService';
import type { BadgeData } from './mainTypes';

export interface CIBadgeLookup {
  byWorkItemId: Map<string, BadgeData>;
  byProviderItemKey: Map<string, BadgeData>;
}

export type CIBadgeWatcherService = Pick<WatcherService, 'getActivePRWatches' | 'getPRWatchKey' | 'getChildRuns'>;

export function buildCIBadgeLookup(
  workItems: readonly WorkItem[],
  allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>,
  watcherService: CIBadgeWatcherService,
): CIBadgeLookup {
  const lookup: CIBadgeLookup = {
    byWorkItemId: new Map(),
    byProviderItemKey: new Map(),
  };
  const workItemIdsByExternalId = new Map<string, string[]>();
  const providerItemKeysByExternalId = new Map<string, string[]>();

  for (const item of workItems) {
    if (!isPRWorkItem(item)) {
      continue;
    }
    const itemIds = workItemIdsByExternalId.get(item.externalId) ?? [];
    itemIds.push(item.id);
    workItemIdsByExternalId.set(item.externalId, itemIds);
  }

  for (const [providerId, items] of allProviderItems) {
    for (const item of items) {
      if (!isPRProviderItem(providerId, item)) {
        continue;
      }
      const keys = providerItemKeysByExternalId.get(item.externalId) ?? [];
      keys.push(getProviderItemKey(providerId, item.externalId));
      providerItemKeysByExternalId.set(item.externalId, keys);
    }
  }

  for (const watch of watcherService.getActivePRWatches()) {
    const badge = computeCIBadge(watcherService.getChildRuns(watcherService.getPRWatchKey(watch.identifier)));
    if (!badge) {
      continue;
    }

    for (const externalId of getPRExternalIds(watch.identifier)) {
      for (const itemId of workItemIdsByExternalId.get(externalId) ?? []) {
        lookup.byWorkItemId.set(itemId, badge);
      }
      for (const providerItemKey of providerItemKeysByExternalId.get(externalId) ?? []) {
        lookup.byProviderItemKey.set(providerItemKey, badge);
      }
    }
  }

  return lookup;
}

export function computeCIBadge(runs: readonly WatchedRun[]): BadgeData | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  if (runs.some(isFailedRun)) {
    return { label: '✗ CI failing', type: 'ci', variant: 'ci-fail' };
  }
  if (runs.some(runWatch => runWatch.status.overallState !== 'completed')) {
    return { label: '⟳ CI running', type: 'ci', variant: 'ci-running' };
  }
  if (runs.some(runWatch => runWatch.hasWarning
    || runWatch.status.conclusion === 'partial_success')) {
    return { label: '⚠ CI warning', type: 'ci', variant: 'ci-warn' };
  }
  if (runs.every(runWatch => runWatch.status.conclusion === 'success')) {
    return { label: '✓ CI passing', type: 'ci', variant: 'ci-pass' };
  }
  return undefined;
}

function isFailedRun(runWatch: WatchedRun): boolean {
  if (runWatch.status.overallState !== 'completed') return false;
  return isFailedConclusion(runWatch.status.conclusion);
}

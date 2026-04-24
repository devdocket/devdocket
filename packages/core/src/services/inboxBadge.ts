import { ProviderRegistry } from './providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { buildCanonicalHiddenSet } from './canonicalDedup';

export function getInboxUnseenCount(
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  seenItems?: ReadonlySet<string>,
): number {
  const hidden = buildCanonicalHiddenSet(
    providerRegistry.getAllDiscoveredItems(),
    (pid, eid) => stateStore.getState(pid, eid),
  );

  // Precompute which canonical groups have any member seen in this session
  const seenCanonicalIds = new Set<string>();
  if (seenItems && seenItems.size > 0) {
    for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
      for (const item of items) {
        if (item.canonicalId && seenItems.has(`${providerId}::${item.externalId}`)) {
          seenCanonicalIds.add(item.canonicalId);
        }
      }
    }
  }

  let count = 0;
  for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
    for (const item of items) {
      const state = stateStore.getState(providerId, item.externalId);
      if (state === undefined || state === 'unseen') {
        const key = `${providerId}::${item.externalId}`;
        if (!hidden.has(key) && !seenItems?.has(key)) {
          // Also treat as seen if any canonical peer was seen this session
          if (item.canonicalId && seenCanonicalIds.has(item.canonicalId)) {
            continue;
          }
          count++;
        }
      }
    }
  }
  return count;
}

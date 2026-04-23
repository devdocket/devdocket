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

  let count = 0;
  for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
    for (const item of items) {
      const state = stateStore.getState(providerId, item.externalId);
      if (state === undefined || state === 'unseen') {
        const key = `${providerId}::${item.externalId}`;
        if (!hidden.has(key) && !seenItems?.has(key)) {
          count++;
        }
      }
    }
  }
  return count;
}

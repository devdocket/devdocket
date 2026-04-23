import { ProviderRegistry } from './providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

export function getInboxUnseenCount(
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  seenItems?: ReadonlySet<string>,
): number {
  // Build the canonicalId hidden set for dedup
  const hidden = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
    for (const item of items) {
      if (!item.canonicalId) { continue; }
      const state = stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }
      const key = `${providerId}::${item.externalId}`;
      let group = groups.get(item.canonicalId);
      if (!group) {
        group = [];
        groups.set(item.canonicalId, group);
      }
      group.push(key);
    }
  }
  for (const members of groups.values()) {
    if (members.length <= 1) { continue; }
    members.sort();
    for (let i = 1; i < members.length; i++) {
      hidden.add(members[i]);
    }
  }

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

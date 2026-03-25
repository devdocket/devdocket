import { ProviderRegistry } from './providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

export function getInboxUnseenCount(providerRegistry: ProviderRegistry, stateStore: DiscoveredStateStore): number {
  let count = 0;
  for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
    for (const item of items) {
      const state = stateStore.getState(providerId, item.externalId);
      if (state === undefined || state === 'unseen') {
        count++;
      }
    }
  }
  return count;
}

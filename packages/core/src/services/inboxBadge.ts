import { ProviderRegistry } from './providerRegistry';
import { InboxStateStore } from '../storage/inboxStateStore';
import { buildCanonicalHiddenSet } from './canonicalDedup';

export function getInboxUnseenCount(
  providerRegistry: ProviderRegistry,
  stateStore: InboxStateStore,
  seenItems?: ReadonlySet<string>,
): number {
  const allProviderItems = providerRegistry.getAllProviderItems();
  const hidden = buildCanonicalHiddenSet(
    allProviderItems,
    (pid, eid) => stateStore.getState(pid, eid),
  );

  // Precompute which canonical groups have any member seen in this session
  const seenCanonicalIds = new Set<string>();
  if (seenItems && seenItems.size > 0) {
    for (const [providerId, items] of allProviderItems) {
      for (const item of items) {
        if (item.canonicalId && seenItems.has(`${providerId}::${item.externalId}`)) {
          seenCanonicalIds.add(item.canonicalId);
        }
      }
    }
  }

  let count = 0;
  for (const [providerId, items] of allProviderItems) {
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

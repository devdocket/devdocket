import { ProviderItem } from '../api/types';

/**
 * Builds a set of `providerId::externalId` keys that should be hidden due to
 * cross-provider canonicalId dedup. For each group of unseen items sharing the
 * same canonicalId, the first key alphabetically is the representative;
 * the rest are hidden.
 */
export function buildCanonicalHiddenSet(
  allItems: Iterable<[string, readonly ProviderItem[]]>,
  getState: (providerId: string, externalId: string) => string | undefined,
): Set<string> {
  const hidden = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const [providerId, items] of allItems) {
    for (const item of items) {
      if (!item.canonicalId) { continue; }
      const state = getState(providerId, item.externalId);
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
  return hidden;
}

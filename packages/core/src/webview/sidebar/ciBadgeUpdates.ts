import type { BadgeData, CIBadgeChangeData, SourceProviderData, TierData } from '../shared/types';

export function applyCIBadgeChangesToTiers(tiers: TierData[], changes: CIBadgeChangeData[]): TierData[] {
  const changesByUrl = indexChangesByUrl(changes);
  if (changesByUrl.size === 0) {
    return tiers;
  }

  let changed = false;
  const nextTiers = tiers.map(tier => {
    let tierChanged = false;
    const nextItems = tier.items.map(item => {
      if (!item.url || !changesByUrl.has(item.url)) {
        return item;
      }

      const nextBadges = replaceCIBadge(item.badges, changesByUrl.get(item.url) ?? null);
      if (nextBadges === item.badges) {
        return item;
      }

      tierChanged = true;
      return { ...item, badges: nextBadges };
    });

    if (!tierChanged) {
      return tier;
    }

    changed = true;
    return { ...tier, items: nextItems };
  });

  return changed ? nextTiers : tiers;
}

export function applyCIBadgeChangesToSources(providers: SourceProviderData[], changes: CIBadgeChangeData[]): SourceProviderData[] {
  const changesByUrl = indexChangesByUrl(changes);
  if (changesByUrl.size === 0) {
    return providers;
  }

  let changed = false;
  const nextProviders = providers.map(provider => {
    let providerChanged = false;
    const nextGroups = provider.groups.map(group => {
      let groupChanged = false;
      const nextItems = group.items.map(item => {
        if (!item.url || !changesByUrl.has(item.url)) {
          return item;
        }

        const nextBadges = replaceCIBadge(item.badges, changesByUrl.get(item.url) ?? null);
        if (nextBadges === item.badges) {
          return item;
        }

        groupChanged = true;
        return { ...item, badges: nextBadges };
      });

      if (!groupChanged) {
        return group;
      }

      providerChanged = true;
      return { ...group, items: nextItems };
    });

    if (!providerChanged) {
      return provider;
    }

    changed = true;
    return { ...provider, groups: nextGroups };
  });

  return changed ? nextProviders : providers;
}

function indexChangesByUrl(changes: CIBadgeChangeData[]): Map<string, BadgeData | null> {
  return changes.reduce((index, change) => {
    index.set(change.url, change.badge);
    return index;
  }, new Map<string, BadgeData | null>());
}

function replaceCIBadge(badges: BadgeData[], nextBadge: BadgeData | null): BadgeData[] {
  const currentCIBadges = badges.filter(badge => badge.type === 'ci');
  if (nextBadge && currentCIBadges.length === 1 && areBadgesEqual(currentCIBadges[0], nextBadge)) {
    return badges;
  }
  if (!nextBadge && currentCIBadges.length === 0) {
    return badges;
  }

  const nonCIBadges = badges.filter(badge => badge.type !== 'ci');
  return nextBadge ? [...nonCIBadges, nextBadge] : nonCIBadges;
}

function areBadgesEqual(a: BadgeData, b: BadgeData): boolean {
  return a.label === b.label && a.type === b.type && a.variant === b.variant;
}
